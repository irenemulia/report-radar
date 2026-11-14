"""Data job: keep a directory of listed companies, read their financial reports in batches, write JSON for the website.

Output (all under docs/data/, published to the gh-pages branch rather than committed to main):
  index.json        one compact row per company, for the ranking and search
  c/<SYMBOL>.json   full analysis of one company (report history, score, green and red flags)
  insights.json     the daily feed: fresh reports, flags that appeared or cleared, reports coming up
  directory.json    every listed company we know of, from Yahoo's screener
  state.json        when each company was last fetched and when its next report is expected
"""
import argparse
import datetime as dt
import json
import math
import os
import re
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "docs", "data")
DETAIL = os.path.join(DATA, "c")
STATE = os.path.join(DATA, "state.json")
DIRECTORY = os.path.join(DATA, "directory.json")
INSIGHTS = os.path.join(DATA, "insights.json")

WORKERS = 4
REFRESH_DAYS = 7          # how often a company is re-read when no new report is expected
FRESH_DAYS = 10           # a report counts as "fresh" for this long after it comes out
FEED_DAYS = 14            # how long an item stays in the daily feed
BIG_USD = 1e9             # the home page and the feed only show companies at least this large
MIN_MCAP_USD = 200e6      # smaller companies are left out of the directory
SITE_TZ = dt.timezone(dt.timedelta(hours=7))  # Jakarta: the site's "today"

# Banks, insurers and property firms borrow by design and have no meaningful free cash flow,
# so the cash and debt checks are skipped for them.
FINANCIAL_SECTORS = {"Financial Services", "Real Estate"}

# Yahoo screener regions: (code, most companies to take)
REGIONS = [
    ("us", 5000), ("jp", 2500), ("cn", 3000), ("hk", 1500), ("in", 2500), ("gb", 1000),
    ("ca", 1000), ("au", 1000), ("kr", 1200), ("tw", 1200), ("id", 600), ("sg", 400),
    ("my", 600), ("th", 600), ("ph", 250), ("vn", 400), ("fr", 500), ("ch", 300),
    ("nl", 200), ("es", 200), ("it", 400), ("se", 500), ("no", 300), ("dk", 200),
    ("fi", 200), ("be", 150), ("pt", 60), ("ie", 60), ("gr", 150), ("pl", 300),
    ("tr", 400), ("il", 400), ("sa", 300), ("ae", 150), ("qa", 60), ("kw", 150),
    ("eg", 150), ("za", 300), ("nz", 150), ("pk", 100),
    # These exchanges also list thousands of foreign companies, so they go last and the
    # duplicate check below keeps each company's busiest listing.
    ("br", 3000), ("de", 4000), ("at", 2000), ("mx", 1500), ("cl", 500), ("ar", 1000),
]
# Only these exchanges within a region (US: no over-the-counter market; Germany: Xetra only)
EXCHANGES = {"us": ["NMS", "NYQ", "NGM", "NCM", "ASE"], "de": ["GER"]}

# Venues that only carry copies of shares listed elsewhere (Cboe Canada, Cboe UK, London IOB)
SKIP_SUFFIXES = (".NE", ".XC", ".IL")

# Currencies Yahoo quotes in hundredths
MINOR = {"GBp": ("GBP", 100), "GBX": ("GBP", 100), "ZAc": ("ZAR", 100), "ILA": ("ILS", 100)}

# Every flag the analysis can raise. The website words them (docs/explain.js); index.json refers
# to them by position in this list.
GREEN = ["g_quarter", "g_sales", "g_profit", "g_turnaround", "g_margin", "g_margin_up", "g_roe", "g_cash",
         "g_net_cash", "g_low_debt", "g_steady", "g_buyback", "g_dividend"]
RED = ["r_quarter", "r_loss", "r_sales_down", "r_profit_drop", "r_margin_down", "r_cash_burn", "r_paper_profit",
       "r_neg_equity", "r_debt", "r_interest", "r_squeeze", "r_dilution", "r_div"]
FLAG_CODES = GREEN + RED
QUARTER_FLAGS = {"g_quarter", "r_quarter"}

# The five parts of the score and the most points each can give
PARTS = {"growth": 20, "profit": 20, "cash": 20, "debt": 20, "steady": 20}


# ---------- helpers ----------

def num(x):
    """Return a plain float, or None for missing/NaN/inf values."""
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def dated(df, *names):
    """Values of the first statement row that has any, as (period end, value), oldest first."""
    if df is None or df.empty:
        return []
    for name in names:
        if name in df.index:
            pairs = [(c.date(), num(v)) for c, v in df.loc[name].items()]
            out = sorted(p for p in pairs if p[1] is not None)
            if out:
                return out
    return []


def yearly(pairs):
    """(period end, value) pairs -> [[year, value], ...]"""
    return [[y, v] for y, v in sorted({d.year: v for d, v in pairs}.items())]


def get_info(t, tries=3):
    for i in range(tries):
        try:
            info = t.info
            if info and (info.get("longName") or info.get("shortName")):
                return info
        except Exception:
            pass
        time.sleep(2 + i * 3)
    return None


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def safe(sym):
    """Symbols double as file names, so only plain ones are accepted."""
    return bool(re.match(r"^[A-Za-z0-9][A-Za-z0-9.\-_&]*$", sym or ""))


def day(iso):
    return dt.date(int(iso[:4]), int(iso[5:7]), int(iso[8:10]))


def to_usd(amount, ccy, fx, minor=True):
    """Convert to US dollars. fx maps currency -> units per dollar. Share prices come in minor
    units for some currencies (pence), market values don't."""
    if amount is None or not ccy:
        return None
    base, div = MINOR.get(ccy, (ccy, 1))
    rate = fx.get(base)
    if not rate:
        return None
    return amount / (div if minor else 1) / rate


def load_fx(previous):
    try:
        with urllib.request.urlopen("https://open.er-api.com/v6/latest/USD", timeout=30) as r:
            rates = json.load(r)["rates"]
        if rates.get("EUR"):
            return rates
    except Exception as e:
        print("exchange rates unavailable (%s); using the previous ones" % e, flush=True)
    return previous or {}


# ---------- directory of listed companies ----------

NAME_NOISE = {"inc", "corp", "corporation", "ltd", "limited", "plc", "sa", "ag", "se", "nv", "tbk", "pt",
              "co", "company", "the", "spa", "asa", "ab", "oyj", "as", "adr", "class", "a", "b"}


def name_key(name):
    words = re.sub(r"[^a-z0-9]+", " ", name.lower()).split()
    return " ".join(w for w in words if w not in NAME_NOISE) or name.lower()


def screen_region(region, limit, fx):
    import yfinance as yf
    from yfinance import EquityQuery

    ops = [EquityQuery("eq", ["region", region]), EquityQuery("gt", ["intradaymarketcap", 0])]
    exchanges = EXCHANGES.get(region)
    if exchanges and len(exchanges) == 1:
        ops.append(EquityQuery("eq", ["exchange", exchanges[0]]))
    elif exchanges:
        ops.append(EquityQuery("or", [EquityQuery("eq", ["exchange", x]) for x in exchanges]))
    query = EquityQuery("and", ops)
    min_usd = MIN_MCAP_USD if fx else 0

    out, offset = [], 0
    while offset < limit:
        res, err = None, None
        for attempt in range(3):
            try:
                res = yf.screen(query, offset=offset, size=250, sortField="intradaymarketcap", sortAsc=False)
                break
            except Exception as e:
                err = e
                time.sleep(3 + attempt * 5)
        if res is None:
            print("  screener %s stopped at %d: %s" % (region, offset, err), flush=True)
            break
        quotes = res.get("quotes") or []
        if not quotes:
            break
        kept = 0
        for q in quotes:
            sym, name = q.get("symbol"), q.get("longName") or q.get("shortName")
            if not safe(sym) or not name or sym.endswith(SKIP_SUFFIXES):
                continue
            ccy = q.get("currency")
            mcap = to_usd(num(q.get("marketCap")), ccy, fx, minor=False)
            if min_usd and (mcap is None or mcap < min_usd):
                continue
            traded = (num(q.get("averageDailyVolume3Month")) or 0) * (to_usd(num(q.get("regularMarketPrice")), ccy, fx) or 0)
            out.append({"t": sym, "name": name, "exch": q.get("fullExchangeName") or q.get("exchange"),
                        "mcap": mcap, "vol": traded, "region": region})
            kept += 1
        if kept == 0 and min_usd:  # sorted largest first, so everything further down is smaller
            break
        offset += 250
        time.sleep(0.4)
    return out


def build_directory(fx, previous):
    found = {}
    for region, limit in REGIONS:
        try:
            rows = screen_region(region, limit, fx)
        except Exception as e:
            print("  screener %s failed: %s" % (region, e), flush=True)
            rows = []
        if not rows:  # keep what we knew about this market rather than dropping it
            rows = [r for r in previous.values() if r.get("region") == region]
        print("directory %s: %d companies" % (region, len(rows)), flush=True)
        for r in rows:
            found.setdefault(r["t"], r)

    # The same company is often listed on several exchanges; keep its busiest listing.
    best = {}
    for r in found.values():
        k = name_key(r["name"])
        cur = best.get(k)
        if cur is None or (r["vol"], r["mcap"] or 0) > (cur["vol"], cur["mcap"] or 0):
            best[k] = r
    keep = {r["t"] for r in best.values()}
    return {t: r for t, r in found.items() if t in keep}


# ---------- fetch ----------

def latest_period(qinc):
    """The newest quarterly (or half-yearly) report next to the same period a year earlier.
    Returns (summary, [[period end, sales, profit], ...])."""
    rev = dated(qinc, "Total Revenue", "Operating Revenue")
    if not rev:
        return None, []
    net = dict(dated(qinc, "Net Income Common Stockholders", "Net Income"))
    end, sales = rev[-1]
    # Many companies outside the US only report every six months
    months = 6 if len(rev) >= 2 and (end - rev[-2][0]).days > 135 else 3
    before = [(d, v) for d, v in rev if abs((end - d).days - 365) <= 20]
    q = {"end": end.isoformat(), "months": months, "rev": sales, "net": net.get(end),
         "rev0": before[-1][1] if before else None, "net0": net.get(before[-1][0]) if before else None}
    return q, [[d.isoformat(), v, net.get(d)] for d, v in rev[-6:]]


def fetch(sym, fx, today):
    import yfinance as yf

    t = yf.Ticker(sym)
    info = get_info(t)
    if not info:
        raise RuntimeError("no info")

    price = num(info.get("currentPrice")) or num(info.get("regularMarketPrice")) or num(info.get("previousClose"))
    if not price:
        raise RuntimeError("no price")

    inc = t.income_stmt
    cf = t.cashflow
    try:
        qinc = t.quarterly_income_stmt
    except Exception:
        qinc = None

    revenue = dated(inc, "Total Revenue", "Operating Revenue")
    if not revenue:
        raise RuntimeError("no income statement")
    ebit = dict(dated(inc, "EBIT", "Operating Income"))
    interest = dict(dated(inc, "Interest Expense", "Interest Expense Non Operating"))
    fy_end = revenue[-1][0]

    q, qhist = latest_period(qinc)

    # Yahoo gives the last or next results date in up to three fields
    stamps = [info.get(k) for k in ("earningsTimestamp", "earningsTimestampStart", "earningsTimestampEnd")]
    dates = sorted({dt.datetime.fromtimestamp(s, dt.timezone.utc).date() for s in stamps if isinstance(s, (int, float))})
    coming = [d for d in dates if d >= today]
    past = [d for d in dates if d < today]

    div_yield = num(info.get("trailingAnnualDividendYield"))
    if div_yield is None and num(info.get("dividendYield")) is not None:
        div_yield = num(info.get("dividendYield")) / 100  # this one comes in percent
    if div_yield is not None and not 0 <= div_yield <= 0.5:
        div_yield = None

    de = num(info.get("debtToEquity"))
    book = num(info.get("bookValue"))
    summary = (info.get("longBusinessSummary") or "").strip()
    mcap = num(info.get("marketCap"))

    return {
        "t": sym,
        "name": info.get("longName") or info.get("shortName"),
        "country": info.get("country"),
        "exch": info.get("fullExchangeName") or info.get("exchange"),
        "sector": info.get("sector") or "Other",
        "industry": info.get("industry"),
        "ccy": info.get("currency"),
        "fccy": info.get("financialCurrency") or info.get("currency"),
        "price": price,
        "mcap": mcap,
        "mcapUsd": to_usd(mcap, info.get("currency"), fx, minor=False),
        "hi52": num(info.get("fiftyTwoWeekHigh")),
        "lo52": num(info.get("fiftyTwoWeekLow")),
        "summary": summary[:700] + ("…" if len(summary) > 700 else ""),
        "web": info.get("website"),
        "fyEnd": fy_end.isoformat(),
        "hist": {
            "revenue": yearly(revenue),
            "net": yearly(dated(inc, "Net Income Common Stockholders", "Net Income")),
            "gross": yearly(dated(inc, "Gross Profit")),
            "opinc": yearly(dated(inc, "Operating Income")),
            "shares": yearly(dated(inc, "Diluted Average Shares", "Basic Average Shares")),
            "fcf": yearly(dated(cf, "Free Cash Flow")),
            "ocf": yearly(dated(cf, "Operating Cash Flow", "Cash Flow From Continuing Operating Activities")),
        },
        "ebit": ebit.get(fy_end),
        "interest": interest.get(fy_end),
        "m": {
            "roe": num(info.get("returnOnEquity")),
            "cash": num(info.get("totalCash")),
            "debt": num(info.get("totalDebt")),
            "de": de / 100 if de is not None else None,  # Yahoo gives percent
            "current": num(info.get("currentRatio")),
            "bookNeg": book is not None and book < 0,
            "payout": num(info.get("payoutRatio")),
            "yield": div_yield,
            "pe": num(info.get("trailingPE")),
            "pb": num(info.get("priceToBook")),
        },
        "q": q,
        "qhist": qhist,
        "next": coming[0].isoformat() if coming else None,
        "lastReport": past[-1].isoformat() if past else None,
    }


# ---------- scoring ----------

def tier(value, steps):
    """steps: list of (threshold, points) checked in order with value >= threshold."""
    if value is None:
        return 0
    for threshold, pts in steps:
        if value >= threshold:
            return pts
    return 0


def cagr(first, last, years):
    """Average yearly growth between two positive values."""
    if first is None or last is None or first <= 0 or last <= 0 or years <= 0:
        return None
    return (last / first) ** (1.0 / years) - 1


def analyse(c, today):
    """Work out the derived figures, the 0-100 score and the green and red flags for a fetched company."""
    h, m = c["hist"], c["m"]
    fin = c["sector"] in FINANCIAL_SECTORS
    rev, net = h["revenue"], h["net"]
    if len(rev) < 2 or len(net) < 2:
        raise RuntimeError("fewer than two years of reports")
    revs, nets = [v for _, v in rev], [v for _, v in net]
    span = rev[-1][0] - rev[0][0]
    last_year = rev[-1][0]

    m["span"] = span
    m["revCagr"] = cagr(revs[0], revs[-1], span)
    m["revChg"] = revs[-1] / revs[-2] - 1 if revs[-2] > 0 else None
    m["netChg"] = nets[-1] / nets[-2] - 1 if nets[-2] > 0 else None
    m["margin"] = nets[-1] / revs[-1] if net[-1][0] == last_year and revs[-1] > 0 else None

    # Operating profit kept from each 100 of sales, first and latest year on record
    by_year = dict(rev)
    opm = [(y, v / by_year[y]) for y, v in h["opinc"] if by_year.get(y, 0) > 0]
    m["opMargin"] = opm[-1][1] if opm and opm[-1][0] == last_year else None
    m["opMargin0"] = opm[0][1] if len(opm) >= 3 and m["opMargin"] is not None else None

    fcfs, ocfs = [v for _, v in h["fcf"]], [v for _, v in h["ocf"]]
    ocf = h["ocf"][-1][1] if h["ocf"] and h["ocf"][-1][0] == net[-1][0] else None
    m["conv"] = ocf / nets[-1] if ocf is not None and nets[-1] > 0 else None

    m["cover"] = c["ebit"] / abs(c["interest"]) if c.get("ebit") is not None and c.get("interest") else None

    # A jump of more than a quarter a year in the share count is almost always a split or bad data
    shares = h["shares"]
    chg = cagr(shares[0][1], shares[-1][1], shares[-1][0] - shares[0][0]) if len(shares) >= 2 else None
    m["sharesChg"] = chg if chg is not None and abs(chg) <= 0.25 else None

    # Where each 100 of sales went in the latest year: making the product, running the company,
    # then interest, tax and everything else, and what was left as profit
    gross, opinc = dict(h["gross"]).get(last_year), dict(h["opinc"]).get(last_year)
    c["split"] = None
    if not fin and gross is not None and opinc is not None and m["margin"] is not None and revs[-1] > 0:
        r = revs[-1]
        split = {"make": (r - gross) / r, "run": (gross - opinc) / r, "other": (opinc - nets[-1]) / r, "profit": nets[-1] / r}
        if split["make"] >= 0 and split["run"] >= 0:
            c["split"] = split

    net_cash = m["cash"] is not None and m["debt"] is not None and m["cash"] >= m["debt"]
    profit_drop = nets[-2] > 0 and nets[-1] < nets[-2] * 0.7
    sales_drops = sum(1 for a, b in zip(revs, revs[1:]) if a > 0 and b < a * 0.95)

    parts = {}

    # 1. Growth: are sales and profit getting bigger?
    g = tier(m["revCagr"], [(0.15, 12), (0.08, 10), (0.03, 7), (0.0, 4)])
    if nets[-1] > 0:
        pc = cagr(nets[0], nets[-1], net[-1][0] - net[0][0])
        g += 8 if pc is None or pc >= 0.08 else 6 if pc >= 0 else 2
    parts["growth"] = g

    # 2. Profitability: how much of each sale is kept, and how hard the owners' money works
    roe = m["roe"]
    if fin:
        parts["profit"] = (tier(roe, [(0.15, 20), (0.10, 15), (0.06, 8), (0.0001, 3)]) if roe is not None
                           else tier(m["margin"], [(0.2, 14), (0.1, 9), (0.0001, 4)]))
    else:
        margin_pts = tier(m["margin"], [(0.2, 10), (0.1, 8), (0.05, 5), (0.0001, 2)])
        parts["profit"] = margin_pts + (tier(roe, [(0.2, 10), (0.12, 7), (0.06, 4), (0.0001, 1)]) if roe is not None else margin_pts)

    # 3. Cash: does the profit actually arrive in the bank?
    if fin or not fcfs:
        parts["cash"] = None
    else:
        p = 6 if fcfs[-1] > 0 else 0
        positive = sum(1 for v in fcfs if v > 0)
        p += 4 if positive == len(fcfs) and len(fcfs) >= 3 else 2 if positive * 2 > len(fcfs) else 0
        if m["conv"] is not None:
            p += tier(m["conv"], [(1.0, 10), (0.8, 7), (0.5, 3)])
        elif ocfs and ocfs[-1] > 0:
            p += 3
        parts["cash"] = p

    # 4. Debt: could it get through a bad year?
    if fin:
        parts["debt"] = None
    elif net_cash:
        parts["debt"] = 20
    elif m["de"] is None and not m["bookNeg"]:
        parts["debt"] = None
    else:
        d = m["de"]
        base = 0 if m["bookNeg"] or d is None else 12 if d < 0.3 else 9 if d < 0.7 else 5 if d < 1.2 else 2 if d < 2 else 0
        parts["debt"] = base + (3 if m["cover"] is None else tier(m["cover"], [(8, 6), (4, 4), (2, 2)]))

    # 5. Steadiness: does it deliver year after year?
    s = sum(1 for v in nets if v > 0) / len(nets) * 10
    s += max(0, 4 - 2 * sales_drops)
    s += 0 if profit_drop else 3
    s += 2 if m["sharesChg"] is None else 3 if m["sharesChg"] <= 0.03 else 0
    parts["steady"] = int(round(s))

    got = sum(v for v in parts.values() if v is not None)
    out_of = sum(PARTS[k] for k, v in parts.items() if v is not None)
    total = got / out_of * 100
    if nets[-1] < 0:  # a company that is losing money can't rank as healthy
        total = min(total, 45)

    # The latest quarterly report only counts while it is reasonably recent
    q = c.get("q")
    q_rev = q_net = None
    if q and q["rev0"] and q["rev0"] > 0 and q["net"] is not None and q["net0"] is not None and (today - day(q["end"])).days <= 200:
        q_rev = q["rev"] / q["rev0"] - 1
        q_net = q["net"] / q["net0"] - 1 if q["net0"] > 0 else None

    flags = []
    if q_rev is not None and q_rev >= 0.05 and q["net"] > 0 and (q_net is None or q_net >= 0.05):
        flags.append("g_quarter")
    if m["revCagr"] is not None and m["revCagr"] >= 0.08 and (m["revChg"] is None or m["revChg"] > 0):
        flags.append("g_sales")
    if nets[0] > 0 and nets[-1] >= nets[0] * 1.25 and not profit_drop:
        flags.append("g_profit")
    if nets[-2] < 0 < nets[-1]:
        flags.append("g_turnaround")
    if not fin and m["margin"] is not None and m["margin"] >= 0.15:
        flags.append("g_margin")
    if m["opMargin0"] is not None and m["opMargin"] > 0 and m["opMargin"] - m["opMargin0"] >= 0.03:
        flags.append("g_margin_up")
    if roe is not None and roe >= 0.18 and (fin or net_cash or (m["de"] is not None and m["de"] < 1.5)):
        flags.append("g_roe")
    if not fin and m["conv"] is not None and m["conv"] >= 1 and fcfs and fcfs[-1] > 0:
        flags.append("g_cash")
    if not fin and net_cash:
        flags.append("g_net_cash")
    elif not fin and m["de"] is not None and m["de"] < 0.3 and not m["bookNeg"]:
        flags.append("g_low_debt")
    if len(nets) >= 4 and all(v > 0 for v in nets):
        flags.append("g_steady")
    if m["sharesChg"] is not None and m["sharesChg"] <= -0.01:
        flags.append("g_buyback")
    if (m["yield"] or 0) >= 0.015 and m["payout"] is not None and 0 < m["payout"] <= 0.7:
        flags.append("g_dividend")

    if q_rev is not None and q_rev <= -0.05 and (q["net"] < 0 or (q_net is not None and q_net <= -0.1)):
        flags.append("r_quarter")
    if nets[-1] < 0:
        flags.append("r_loss")
    if (m["revChg"] is not None and m["revChg"] < -0.05) or (m["revCagr"] is not None and m["revCagr"] < -0.03):
        flags.append("r_sales_down")
    if profit_drop and nets[-1] >= 0:
        flags.append("r_profit_drop")
    if m["opMargin0"] is not None and m["opMargin0"] - m["opMargin"] >= 0.04:
        flags.append("r_margin_down")
    if not fin and fcfs and fcfs[-1] < 0:
        flags.append("r_cash_burn")
    if not fin and m["conv"] is not None and m["conv"] < 0.5:
        flags.append("r_paper_profit")
    if not fin and m["bookNeg"]:
        flags.append("r_neg_equity")
    elif not fin and not net_cash and m["de"] is not None and m["de"] > 2:
        flags.append("r_debt")
    if not fin and not net_cash and m["cover"] is not None and m["cover"] < 2:
        flags.append("r_interest")
    if not fin and m["current"] is not None and m["current"] < 0.7:
        flags.append("r_squeeze")
    if m["sharesChg"] is not None and m["sharesChg"] > 0.05:
        flags.append("r_dilution")
    if m["yield"] and m["payout"] is not None and m["payout"] > 1:
        flags.append("r_div")

    c["score"] = int(round(total))
    c["parts"] = parts
    c["flags"] = flags
    return c


def changes(old, c, today):
    """Note when the latest report was first seen, and list what changed since the previous
    analysis. Only larger companies make it into the feed."""
    iso = today.isoformat()
    old = old or {}
    q, oq = c.get("q"), old.get("q")
    c["qSeen"] = None
    if q and oq:
        c["qSeen"] = iso if q["end"] > oq["end"] else old.get("qSeen")
    elif q and c.get("lastReport"):
        # First time we read this company: trust Yahoo's results date if the report fits it
        last = day(c["lastReport"])
        if (today - last).days <= FRESH_DAYS and 0 < (last - day(q["end"])).days <= 100:
            c["qSeen"] = c["lastReport"]

    if (c.get("mcapUsd") or 0) < BIG_USD:
        return []
    out = []
    if c["qSeen"] and c["qSeen"] != old.get("qSeen"):
        out.append({"kind": "report", "d": c["qSeen"], "t": c["t"], "end": q["end"], "months": q["months"],
                    "rev": q["rev"], "rev0": q["rev0"], "net": q["net"], "net0": q["net0"], "ccy": c.get("fccy")})
    if old.get("score") is not None:
        if abs(c["score"] - old["score"]) >= 8:
            out.append({"kind": "score", "d": iso, "t": c["t"], "from": old["score"], "to": c["score"]})
        was, now = set(old.get("flags") or []) - QUARTER_FLAGS, set(c["flags"]) - QUARTER_FLAGS
        for f in FLAG_CODES:
            if f in now and f not in was:
                out.append({"kind": "flag_new", "d": iso, "t": c["t"], "flag": f})
            elif f in was and f not in now and f in RED:
                out.append({"kind": "flag_gone", "d": iso, "t": c["t"], "flag": f})
    return out


# ---------- choosing and fetching a batch ----------

def pick(directory, state, today, budget):
    """Companies whose results date has just passed come first, then companies never analysed
    (largest first), then the ones whose analysis is oldest."""
    iso = today.isoformat()
    reported, new, due = [], [], []
    for sym, d in directory.items():
        st = state.get(sym)
        if not st or (not st.get("u") and st.get("f", 0) < 3):
            new.append((-(d.get("mcap") or 0), sym))
            continue
        last = st.get("u") or st.get("t") or ""
        e = st.get("e")
        # Yahoo can take a day to load new figures, so look on each of the two days after the date
        if st.get("u") and e and e < iso and st.get("t", "") < iso and st["u"] <= (day(e) + dt.timedelta(days=1)).isoformat():
            reported.append((-(d.get("mcap") or 0), sym))
            continue
        wait = 30 if st.get("f", 0) >= 3 else REFRESH_DAYS
        if last <= (today - dt.timedelta(days=wait)).isoformat():
            due.append((last, sym))
    queue = [s for _, s in sorted(reported)] + [s for _, s in sorted(new)] + [s for _, s in sorted(due)]
    return queue[:budget]


class Skipped(Exception):
    pass


def run_fetch(todo, fx, state, today, minutes):
    """Fetch and analyse the given symbols. Returns the feed items they produced."""
    iso = today.isoformat()
    started = time.time()
    ctl = {"stop": False, "pause_until": 0}
    recent, pauses, events = [], 0, []

    def work(sym):
        while time.time() < ctl["pause_until"]:
            time.sleep(1)
        if ctl["stop"] or time.time() - started > minutes * 60:
            raise Skipped()
        time.sleep(0.3)
        return analyse(fetch(sym, fx, today), today)

    def batch(symbols, workers):
        nonlocal recent, pauses
        done, errors = 0, {}
        with ThreadPoolExecutor(workers) as pool:
            futures = {pool.submit(work, s): s for s in symbols}
            for i, fut in enumerate(as_completed(futures), 1):
                sym = futures[fut]
                try:
                    c = fut.result()
                except Skipped:
                    continue
                except Exception as e:
                    errors[sym] = str(e)
                    recent.append(0)
                else:
                    done += 1
                    recent.append(1)
                    path = os.path.join(DETAIL, sym + ".json")
                    events.extend(changes(load_json(path), c, today))
                    c["updated"] = iso
                    save_json(path, c)
                    state[sym] = {"u": iso, "t": iso, "f": 0, "e": c["next"] or c["lastReport"]}
                # Yahoo throttling shows up as a run of failures: wait, and give up after the third time
                recent = recent[-80:]
                if len(recent) == 80 and sum(recent) < 20:
                    pauses += 1
                    recent = []
                    if pauses >= 3:
                        ctl["stop"] = True
                        print("Too many failures; stopping this batch early.", flush=True)
                    else:
                        print("Many failures; pausing for 2 minutes.", flush=True)
                        ctl["pause_until"] = time.time() + 120
                if i % 100 == 0:
                    print("%d/%d done (%d ok, %d failed)" % (i, len(symbols), done, len(errors)), flush=True)
        return done, errors

    ok, errors = batch(todo, WORKERS)
    if errors and not ctl["stop"]:
        # Most failures are brief throttling, so give them a second, gentler try
        print("retrying %d that failed" % len(errors), flush=True)
        time.sleep(60)
        recent = []
        again, errors = batch(list(errors), 2)
        ok += again
    for n, (sym, msg) in enumerate(errors.items()):
        st = state.setdefault(sym, {})
        st["t"] = iso
        st["f"] = st.get("f", 0) + 1
        if n < 40:
            print("  fail %s: %s" % (sym, msg), flush=True)
    print("fetched %d, failed %d, of %d planned" % (ok, len(errors), len(todo)), flush=True)
    return events


# ---------- index and insights ----------

INDEX_COLS = ["t", "name", "country", "sector", "industry", "score", "flags", "growth", "margin",
              "mcap", "big", "exch", "na", "rep"]


def build_index(directory, state, today):
    """Returns (index rows, results dates coming up at larger companies)."""
    stale_cutoff = (today - dt.timedelta(days=30)).isoformat()
    fresh_cutoff = (today - dt.timedelta(days=FRESH_DAYS)).isoformat()
    horizon = (today + dt.timedelta(days=10)).isoformat()
    code = {f: i for i, f in enumerate(FLAG_CODES)}
    r4 = lambda x: round(x, 4) if x is not None else None
    analysed, upcoming = [], []
    for fname in os.listdir(DETAIL):
        if not fname.endswith(".json"):
            continue
        path = os.path.join(DETAIL, fname)
        c = load_json(path)
        if not c or c.get("score") is None:
            continue
        sym = c["t"]
        if sym not in directory and c.get("updated", "") < stale_cutoff:
            os.remove(path)  # no longer listed, or fell out of the directory
            continue
        d = directory.get(sym) or {}
        usd = c.get("mcapUsd") or d.get("mcap")
        big = (usd or 0) >= BIG_USD
        seen = c.get("qSeen")
        analysed.append([sym, c.get("name") or d.get("name") or sym, c.get("country"), c.get("sector"),
                         c.get("industry"), c["score"], [code[f] for f in c.get("flags") or [] if f in code],
                         r4(c["m"].get("revCagr")), r4(c["m"].get("margin")),
                         int(usd / 1e6) if usd else None, 1 if big else 0, c.get("exch") or d.get("exch"), 0,
                         seen if seen and seen >= fresh_cutoff else None])
        if big and c.get("next") and today.isoformat() <= c["next"] <= horizon:
            upcoming.append({"t": sym, "d": c["next"], "mcap": int(usd / 1e6)})
    done = {r[0] for r in analysed}
    pending = []
    for sym, d in directory.items():
        if sym in done:
            continue
        no_data = 1 if state.get(sym, {}).get("f", 0) >= 3 else 0
        pending.append([sym, d["name"], None, None, None, None, None, None, None,
                        int(d["mcap"] / 1e6) if d.get("mcap") else None, 0, d.get("exch"), no_data, None])
    analysed.sort(key=lambda r: (-r[5], -(r[9] or 0)))
    pending.sort(key=lambda r: -(r[9] or 0))
    upcoming.sort(key=lambda u: (u["d"], -u["mcap"]))
    return analysed + pending, len(analysed), upcoming


def merge_events(events, today):
    """Tidy the feed (newest items first in the input): drop duplicates and old items."""
    cutoff = (today - dt.timedelta(days=FEED_DAYS)).isoformat()
    seen, out = set(), []
    for e in events:
        key = (e["t"], e["kind"], e.get("flag") or e.get("end") or e["d"])
        if e["d"] < cutoff or key in seen or not os.path.exists(os.path.join(DETAIL, e["t"] + ".json")):
            continue
        seen.add(key)
        out.append(e)
    out.sort(key=lambda e: e["d"], reverse=True)
    return out


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("symbols", nargs="*", help="only analyse these symbols")
    ap.add_argument("--budget", type=int, default=3000, help="companies to analyse in this batch")
    ap.add_argument("--minutes", type=int, default=80, help="stop fetching after this long")
    ap.add_argument("--no-fetch", action="store_true", help="only rebuild the index from what is already saved")
    args = ap.parse_args()

    os.makedirs(DETAIL, exist_ok=True)
    today = dt.datetime.now(SITE_TZ).date()
    state = load_json(STATE) or {}
    saved = load_json(DIRECTORY) or {}
    fx, directory = saved.get("fx") or {}, saved.get("c") or {}
    events = (load_json(INSIGHTS) or {}).get("events") or []

    if not args.no_fetch:
        fx = load_fx(fx)
        if not args.symbols and saved.get("date") != today.isoformat():
            fresh = build_directory(fx, directory)
            if fresh and len(fresh) >= 0.6 * len(directory):
                directory = fresh
                save_json(DIRECTORY, {"date": today.isoformat(), "fx": fx, "c": directory})
            else:
                print("directory refresh looks incomplete (%d companies); keeping the previous one" % len(fresh))
        print("directory: %d companies" % len(directory), flush=True)
        todo = [s for s in args.symbols if safe(s)] or pick(directory, state, today, args.budget)
        events = run_fetch(todo, fx, state, today, args.minutes) + events
        save_json(STATE, state)

    rows, analysed, upcoming = build_index(directory, state, today)
    save_json(os.path.join(DATA, "index.json"), {
        "date": today.isoformat(), "cols": INDEX_COLS, "flagCodes": FLAG_CODES, "rows": rows,
        "analysed": analysed, "minMcapUsd": MIN_MCAP_USD, "bigUsd": BIG_USD,
    })
    save_json(INSIGHTS, {"date": today.isoformat(), "events": merge_events(events, today), "upcoming": upcoming[:80]})
    print("index: %d companies, %d analysed" % (len(rows), analysed), flush=True)


if __name__ == "__main__":
    main()
