// Every piece of plain-language text on the site lives here.
// Tones: "good" (green), "ok" (amber), "bad" (red), "na" (grey).

const pct = (x, d = 1) => (x * 100).toFixed(d).replace(/\.0$/, "") + "%";
const per100 = (x, d = 0) => (x * 100).toFixed(d).replace(/\.0$/, "");
// "up 12%", "down 5%" or "about the same"
const moved = (x) => (Math.abs(x) < 0.005 ? "about the same" : (x > 0 ? "up " : "down ") + pct(Math.abs(x), Math.abs(x) < 0.1 ? 1 : 0));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const FINANCIAL = new Set(["Financial Services", "Real Estate"]);

// The five parts of the score, in display order. `max` matches pipeline/build.py.
const PARTS = [
  { key: "growth", max: 20, title: "Growth", question: "Is the business getting bigger?" },
  { key: "profit", max: 20, title: "Profitability", question: "How much of what it sells does it keep?" },
  { key: "cash", max: 20, title: "Real cash", question: "Does the profit actually arrive in the bank?" },
  { key: "debt", max: 20, title: "Debt", question: "Could it get through a bad year?" },
  { key: "steady", max: 20, title: "Steadiness", question: "Does it deliver year after year?" },
];

const first = (pairs) => pairs[0];
const last = (pairs) => pairs[pairs.length - 1];
const periodName = (months) => (months === 6 ? "half-year" : "three months");

function explainPart(key, c) {
  const m = c.m, h = c.hist, fc = c.fccy;
  const fin = FINANCIAL.has(c.sector);
  const got = c.parts[key];
  const tone = got == null ? "na" : got >= 15 ? "good" : got >= 9 ? "ok" : "bad";
  const who = c.sector === "Real Estate" ? "Property companies" : "Banks and insurers";
  switch (key) {
    case "growth": {
      const [y0, r0] = first(h.revenue), [y1, r1] = last(h.revenue);
      let t = `Sales went from ${money(r0, fc)} in ${y0} to ${money(r1, fc)} in ${y1}`;
      t += m.revCagr == null ? "." : Math.abs(m.revCagr) < 0.005 ? ", so they have barely moved." : `, about ${pct(Math.abs(m.revCagr))} ${m.revCagr > 0 ? "more" : "less"} each year.`;
      const n0 = first(h.net)[1], n1 = last(h.net)[1];
      if (n1 < 0) t += ` In the latest year it made a loss of ${money(-n1, fc)}.`;
      else if (n0 <= 0) t += ` It moved from a loss to a profit of ${money(n1, fc)}.`;
      else t += ` Profit went from ${money(n0, fc)} to ${money(n1, fc)}.`;
      return { tone, text: t };
    }
    case "profit": {
      let t = "";
      if (m.margin != null)
        t = m.margin >= 0
          ? `Out of every 100 it sold in ${last(h.revenue)[0]}, ${per100(m.margin, 1)} was left as profit after every cost.`
          : `For every 100 it sold in ${last(h.revenue)[0]}, it lost ${per100(-m.margin, 1)}.`;
      if (m.roe != null && m.roe > 0) t += ` For every 100 of the owners' own money in the business, it earned ${per100(m.roe)} in a year.`;
      if (fin) t += ` ${who} are judged here mainly on that second number.`;
      return { tone, text: t || "There's no profitability data available." };
    }
    case "cash": {
      if (got == null) return { tone: "na", text: fin ? `${who} move cash around as their normal business, so this test doesn't apply. It's left out of their score.` : "There's no cash flow data available, so this part is left out of the score." };
      const [y, f] = last(h.fcf);
      const positive = h.fcf.filter((p) => p[1] > 0).length;
      let t = f >= 0
        ? `After paying its bills and investing in buildings and equipment, it had ${money(f, fc)} of spare cash left in ${y}.`
        : `In ${y} it spent ${money(-f, fc)} more cash than the business brought in.`;
      if (h.fcf.length > 1) t += ` It ended with spare cash in ${positive} of the last ${h.fcf.length} years.`;
      if (m.conv != null) t += ` For every 100 of profit it reported, ${per100(m.conv)} arrived as actual cash.`;
      return { tone, text: t };
    }
    case "debt": {
      if (got == null) return { tone: "na", text: fin ? `${who} borrow money as part of their normal business, so the usual debt test doesn't apply. It's left out of their score.` : "There's no debt data available, so this part is left out of the score." };
      if (m.cash != null && m.debt != null && m.cash >= m.debt)
        return { tone, text: `It has more cash in the bank (${money(m.cash, fc)}) than all its debt (${money(m.debt, fc)}), like a household whose savings are bigger than its mortgage.` };
      let t = m.bookNeg ? "Everything it owns is worth less than everything it owes."
        : `For every 100 of the owners' own money in the business, it has borrowed ${per100(m.de)}.` + (m.de < 0.3 ? " That's very little." : m.de < 0.7 ? " That's a moderate, manageable amount." : m.de < 1.2 ? " That's quite a lot." : " That's heavy.");
      if (m.cover != null) t += m.cover <= 0 ? " It didn't earn enough to pay the interest on its loans." : ` Its yearly profit before interest and tax would pay the interest bill ${m.cover >= 50 ? "more than 50" : m.cover.toFixed(1)} times over.`;
      return { tone, text: t };
    }
    case "steady": {
      const nets = h.net.map((p) => p[1]);
      const revs = h.revenue.map((p) => p[1]);
      const drops = revs.filter((v, i) => i > 0 && revs[i - 1] > 0 && v < revs[i - 1] * 0.95).length;
      let t = `It made a profit in ${nets.filter((v) => v > 0).length} of the last ${nets.length} years.`;
      t += drops ? ` Sales fell noticeably in ${drops} of them.` : " Sales never fell by much.";
      if (m.sharesChg != null && m.sharesChg > 0.03) t += ` The number of shares grows about ${pct(m.sharesChg)} a year, which thins out each owner's slice.`;
      return { tone, text: t };
    }
  }
}

// `about` is the general meaning (Learn page); explainFlag() below adds the company's own numbers.
const FLAGS = {
  g_quarter: { tone: "good", short: "Strong latest report", title: "The latest report was strong", about: "Sales and profit were both clearly higher than in the same months a year earlier." },
  g_sales: { tone: "good", short: "Sales growing", title: "Sales are growing fast", about: "Sales have grown by 8% a year or more. More customers or higher prices: either way the business is getting bigger." },
  g_profit: { tone: "good", short: "Profit growing", title: "Profit is growing", about: "Profit is at least a quarter higher than a few years ago." },
  g_turnaround: { tone: "good", short: "Back in profit", title: "Back in profit", about: "It lost money the year before and made a profit in the latest year." },
  g_margin: { tone: "good", short: "Keeps a lot of each sale", title: "Keeps a big slice of every sale", about: "At least 15 of every 100 in sales is left as profit. Most companies keep less than 10." },
  g_margin_up: { tone: "good", short: "More profitable", title: "Becoming more profitable", about: "It keeps a bigger slice of each sale than a few years ago, so it is controlling costs or charging more." },
  g_roe: { tone: "good", short: "Works its money hard", title: "Earns a lot on the owners' money", about: "It earns 18 or more a year on every 100 of the owners' money, without relying on heavy debt to do it." },
  g_cash: { tone: "good", short: "Profit is real cash", title: "Profit shows up as real cash", about: "The cash that came in matches or beats the profit it reported. Profit you can see in the bank is profit you can trust." },
  g_net_cash: { tone: "good", short: "More cash than debt", title: "More cash than debt", about: "It could pay off every loan tomorrow and still have money left." },
  g_low_debt: { tone: "good", short: "Little debt", title: "Very little debt", about: "It has borrowed less than 30 for every 100 of the owners' own money." },
  g_steady: { tone: "good", short: "Profit every year", title: "Profitable every year", about: "It made a profit in every year on record, with no losing years." },
  g_buyback: { tone: "good", short: "Buys back shares", title: "Buying back its own shares", about: "The number of shares is shrinking, so each remaining share owns a slightly bigger slice of the company." },
  g_dividend: { tone: "good", short: "Affordable dividend", title: "Pays a dividend it can afford", about: "It shares part of its profit with shareholders in cash and keeps a healthy part as a cushion." },

  r_quarter: { tone: "bad", short: "Weak latest report", title: "The latest report was weak", about: "Sales and profit were both clearly lower than in the same months a year earlier." },
  r_loss: { tone: "bad", short: "Losing money", title: "It is losing money", about: "It spent more than it earned in its latest year. A company can only do that for as long as its savings or its lenders allow." },
  r_sales_down: { tone: "bad", short: "Sales shrinking", title: "Sales are shrinking", about: "It is selling less than before. Costs rarely shrink as fast as sales do." },
  r_profit_drop: { tone: "bad", short: "Profit fell sharply", title: "Profit fell sharply", about: "Profit dropped by more than 30% in a single year." },
  r_margin_down: { tone: "bad", short: "Less profitable", title: "Keeps less of each sale than before", about: "Its costs are rising faster than its prices, so a smaller slice of each sale is left as profit." },
  r_cash_burn: { tone: "bad", short: "Burning cash", title: "Spends more cash than it brings in", about: "The gap has to be filled from savings, new loans or new shares." },
  r_paper_profit: { tone: "bad", short: "Profit isn't cash", title: "Profit isn't turning into cash", about: "It reports a profit, but less than half of it arrived as cash. Customers may be paying late, or the accounts may be flattering." },
  r_neg_equity: { tone: "bad", short: "Owes more than it owns", title: "Owes more than it owns", about: "Its debts are bigger than everything it owns. It sometimes happens to strong companies that borrowed to buy back shares, but it leaves no cushion." },
  r_debt: { tone: "bad", short: "Heavy debt", title: "Heavy debt", about: "It has borrowed more than twice the owners' own money. In a bad year, lenders are paid before shareholders." },
  r_interest: { tone: "bad", short: "Interest is a strain", title: "Struggles to pay its interest", about: "Its profit covers the interest on its loans less than twice. A small fall in profit would make paying lenders a struggle." },
  r_squeeze: { tone: "bad", short: "Tight on short-term cash", title: "Tight on money for upcoming bills", about: "The bills due within a year are much bigger than the cash and other quick money it has on hand." },
  r_dilution: { tone: "bad", short: "Keeps issuing shares", title: "Keeps issuing new shares", about: "Each new share makes the existing ones a smaller slice of the company, like cutting a pizza into more pieces." },
  r_div: { tone: "bad", short: "Dividend exceeds profit", title: "Pays out more than it earns", about: "Its dividend is bigger than its profit, which can't go on for long." },
};

function explainFlag(code, c) {
  const m = c.m, h = c.hist, fc = c.fccy, q = c.q;
  const [y0, r0] = first(h.revenue), [y1, r1] = last(h.revenue);
  const n0 = first(h.net), n1 = last(h.net), nPrev = h.net[h.net.length - 2];
  const quarter = () => {
    const sales = `In the ${periodName(q.months)} to ${fmtDate(q.end)}, sales were ${moved(q.rev / q.rev0 - 1)} on the same period a year earlier`;
    if (q.net < 0) return `${sales}, and it made a loss of ${money(-q.net, fc)}.`;
    if (q.net0 <= 0) return `${sales}, and it moved from a loss to a profit of ${money(q.net, fc)}.`;
    return `${sales}, and profit was ${moved(q.net / q.net0 - 1)}.`;
  };
  switch (code) {
    case "g_quarter": case "r_quarter": return quarter();
    case "g_sales": return `Sales grew about ${pct(m.revCagr)} a year, from ${money(r0, fc)} in ${y0} to ${money(r1, fc)} in ${y1}. More customers or higher prices: either way the business is getting bigger.`;
    case "g_profit": return `Profit rose from ${money(n0[1], fc)} in ${n0[0]} to ${money(n1[1], fc)} in ${n1[0]}.`;
    case "g_turnaround": return `It lost ${money(-nPrev[1], fc)} in ${nPrev[0]} and made a profit of ${money(n1[1], fc)} in ${n1[0]}.`;
    case "g_margin": return `Out of every 100 it sells, ${per100(m.margin)} is left as profit after every cost. Most companies keep less than 10.`;
    case "g_margin_up": return `From running its business it kept ${per100(m.opMargin)} of every 100 in sales, up from ${per100(m.opMargin0)} in ${y0}. It is getting better at controlling costs or charging more.`;
    case "g_roe": return `For every 100 of the owners' own money in the business, it earned ${per100(m.roe)} in a year. A savings account earns 3 or 4.`;
    case "g_cash": return `For every 100 of profit it reported, ${per100(m.conv)} arrived as actual cash. Profit you can see in the bank is profit you can trust.`;
    case "g_net_cash": return `It has ${money(m.cash, fc)} in cash and owes ${money(m.debt, fc)}, like a household whose savings are bigger than its mortgage.`;
    case "g_low_debt": return `For every 100 of the owners' own money, it has borrowed only ${per100(m.de)}.`;
    case "g_steady": return `It made a profit in each of the last ${h.net.length} years on record.`;
    case "g_buyback": return `The number of shares shrinks about ${pct(-m.sharesChg)} a year because the company buys its own shares back. Each remaining share owns a slightly bigger slice of the company.`;
    case "g_dividend": return `It hands shareholders ${per100(m.payout)} of every 100 it earns (a ${pct(m.yield)} yearly cash return at today's share price) and keeps the rest as a cushion.`;

    case "r_loss": return `It lost ${money(-n1[1], fc)} in ${n1[0]}: it spent more than it earned. A company can only do that for as long as its savings or its lenders allow.`;
    case "r_sales_down": return m.revChg != null && m.revChg < -0.05
      ? `Sales fell ${pct(-m.revChg)} in ${y1}, to ${money(r1, fc)}. Costs rarely shrink as fast as sales do.`
      : `Sales have shrunk about ${pct(-m.revCagr)} a year, from ${money(r0, fc)} in ${y0} to ${money(r1, fc)} in ${y1}.`;
    case "r_profit_drop": return `Profit fell ${pct(-m.netChg, 0)} in one year, from ${money(nPrev[1], fc)} to ${money(n1[1], fc)}.`;
    case "r_margin_down": return m.opMargin < 0
      ? `Running its business now loses ${per100(-m.opMargin)} on every 100 in sales. In ${y0} it kept ${per100(m.opMargin0)}. Costs are rising faster than prices.`
      : `From running its business it kept ${per100(m.opMargin)} of every 100 in sales, down from ${per100(m.opMargin0)} in ${y0}. Costs are rising faster than prices.`;
    case "r_cash_burn": { const f = last(h.fcf); return `In ${f[0]} it spent ${money(-f[1], fc)} more cash than the business brought in. The gap has to be filled from savings, new loans or new shares.`; }
    case "r_paper_profit": return m.conv <= 0
      ? `It reported a profit of ${money(n1[1], fc)}, but more cash left the business than came in. Customers may be paying late, or the accounts may be flattering.`
      : `For every 100 of profit it reported, only ${per100(m.conv)} arrived as cash. Customers may be paying late, or the accounts may be flattering.`;
    case "r_neg_equity": return FLAGS.r_neg_equity.about;
    case "r_debt": return `For every 100 of the owners' own money, it has borrowed ${per100(m.de)}. In a bad year, lenders are paid before shareholders.`;
    case "r_interest": return m.cover <= 0
      ? "It didn't earn enough from its business to pay the interest on its loans."
      : `Its profit before interest and tax pays its interest bill only ${m.cover.toFixed(1)} times over. A small fall in profit would make paying lenders a struggle.`;
    case "r_squeeze": return `For every 100 of bills due within a year, it has only ${per100(m.current)} in cash and things it can quickly turn into cash.`;
    case "r_dilution": return `The number of shares grows about ${pct(m.sharesChg)} a year. Each new share makes the existing ones a smaller slice of the company, like cutting a pizza into more pieces.`;
    case "r_div": return `It pays out ${per100(m.payout)} in dividends for every 100 of profit, which is more than it earns.`;
  }
  return "";
}

function verdict(score) {
  if (score >= 75) return { label: "Strong", tone: "good", text: "Its financial reports look healthy on nearly every check." };
  if (score >= 60) return { label: "Healthy", tone: "good", text: "In good shape overall, with a weak spot or two." };
  if (score >= 45) return { label: "Mixed", tone: "ok", text: "Some parts of its reports look fine, others need care." };
  return { label: "Fragile", tone: "bad", text: "Its reports show real problems right now." };
}

// The share price is deliberately kept out of the score; this puts it in words instead.
function explainPrice(c) {
  const pe = c.m.pe;
  if (pe == null || pe <= 0) return "There's no price-to-profit figure, usually because the company made no profit over the last 12 months. Its share price rests on what buyers hope it will earn in the future.";
  const t = `At today's share price, buyers pay ${pe.toFixed(1)} years of the company's current profit for each share (a "P/E" of ${pe.toFixed(1)}).`;
  if (pe <= 10) return t + " That's a low price tag. It can be a bargain, or a sign that buyers expect profit to fall.";
  if (pe <= 25) return t + " That's an ordinary price tag.";
  return t + " That's a high price tag: buyers expect profit to grow fast, and the share price can fall hard if it doesn't.";
}

// Two or three sentences that sum the company up for someone who has never read a financial report.
function plainSummary(c) {
  const m = c.m, fc = c.fccy;
  const sales = last(c.hist.revenue)[1], profit = last(c.hist.net)[1];
  const when = new Date(c.fyEnd + "T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  let t = `In its latest financial year (to ${when}) it sold ${money(sales, fc)} of goods and services`;
  t += profit >= 0 ? ` and kept ${money(profit, fc)} of that as profit.` : ` and lost ${money(-profit, fc)}.`;
  if (m.revCagr != null)
    t += Math.abs(m.revCagr) < 0.01 ? ` Sales have been flat over the last ${m.span} years.`
      : ` Sales have ${m.revCagr > 0 ? "grown" : "shrunk"} about ${pct(Math.abs(m.revCagr))} a year over the last ${m.span} years.`;
  return t;
}

// Daily feed text. `c` is the company's row from the index.
function explainEvent(ev, c) {
  const n = c.name;
  switch (ev.kind) {
    case "report": {
      const rev = ev.rev0 > 0 ? ev.rev / ev.rev0 - 1 : null;
      const net = ev.net != null && ev.net0 > 0 ? ev.net / ev.net0 - 1 : null;
      let t = `In the ${periodName(ev.months)} to ${fmtDate(ev.end)}, sales were ${money(ev.rev, ev.ccy)}${rev != null ? `, ${moved(rev)} on a year earlier` : ""}.`;
      if (ev.net != null) t += ev.net < 0 ? ` It made a loss of ${money(-ev.net, ev.ccy)}.` : ` Profit was ${money(ev.net, ev.ccy)}${net != null ? `, ${moved(net)}` : ev.net0 != null && ev.net0 <= 0 ? ", after a loss a year earlier" : ""}.`;
      const up = rev != null && rev > 0.005 && ev.net > 0 && (net == null || net > 0.005);
      const down = rev != null && rev < -0.005 && (ev.net < 0 || (net != null && net < -0.005));
      return { icon: up ? "▲" : down ? "▼" : "●", tone: up ? "good" : down ? "bad" : "ok", title: `${n} published new results`, text: t };
    }
    case "score": {
      const up = ev.to > ev.from;
      return { icon: up ? "▲" : "▼", tone: up ? "good" : "bad", title: `${n}'s score ${up ? "rose" : "fell"} from ${ev.from} to ${ev.to}`, text: up ? "Its newest numbers look healthier than before." : "Its newest numbers look weaker than before. Open it to see which part slipped." };
    }
    case "flag_new": {
      const f = FLAGS[ev.flag];
      if (!f) return null;
      return { icon: "⚑", tone: f.tone, title: `New ${f.tone === "good" ? "green" : "red"} flag for ${n}`, text: `${f.title}. ${f.about}` };
    }
    case "flag_gone": {
      const f = FLAGS[ev.flag];
      if (!f) return null;
      return { icon: "✓", tone: "good", title: `A red flag cleared for ${n}`, text: `This no longer applies: "${f.title}".` };
    }
  }
  return null;
}

// One short lesson per day, picked by date.
const LESSONS = [
  { title: "What is a financial report?", text: "Every company on a stock market must publish its numbers, usually every three months and in full once a year. It's a school report card for a business: what it sold, what it spent, what it owns and what it owes." },
  { title: "The three pages that matter", text: "The income statement shows what was sold and what was left as profit. The balance sheet shows what the company owns and owes on one day. The cash flow statement shows the actual money that came in and went out. This site reads all three for you." },
  { title: "Sales (revenue)", text: "All the money customers paid the company, before any costs. If a bakery sells 1,000 loaves at 3 each, its sales are 3,000. It's the first line of every income statement." },
  { title: "Profit (net income)", text: "What's left of sales after every cost: ingredients, wages, rent, interest on loans and tax. If the bakery's 3,000 of sales cost 2,700 to make, the profit is 300. It's often called the bottom line because it's the last line." },
  { title: "Profit margin", text: "Profit ÷ sales: how much of each sale is kept. A bakery that keeps 300 of 3,000 has a 10% margin. Supermarkets live on 2 to 3%, software companies on 25% or more, so compare companies in the same industry." },
  { title: "Profit is not the same as cash", text: "Profit is counted when a sale is made, even if the customer hasn't paid yet. So a company can report a profit and still run short of money. That's why we check whether profit actually arrives as cash." },
  { title: "Free cash flow", text: "The cash left after paying to run the business and to buy equipment and buildings. It's what the company can freely use to pay off debt, pay dividends or save. A company that burns cash year after year needs someone else's money to keep going." },
  { title: "Debt", text: "Borrowing isn't bad in itself, since most companies borrow to grow. The danger is borrowing so much that interest eats the profit. In a bad year, lenders must be paid first and shareholders get what's left." },
  { title: "Owners' money (equity)", text: "Everything the company owns minus everything it owes. It's what would belong to the shareholders if the company sold everything and paid every debt. If it is negative, the company owes more than it owns." },
  { title: "Why growth matters", text: "A company whose sales grow 10% a year doubles in size in about seven years. But growth only counts if profit follows: selling more while losing more on each sale isn't progress." },
  { title: "Compare with a year earlier", text: "Many businesses have seasons: shops sell more in December, airlines in summer. So a quarter is compared with the same quarter last year, not with the one just before it." },
  { title: "New shares and buybacks", text: "A company is a pizza cut into shares. Issuing new shares cuts it into more slices, so yours gets smaller. Buying shares back does the opposite: fewer slices, each one bigger." },
  { title: "One good year isn't a pattern", text: "A single great year can come from luck: a price spike or a one-time sale. Look for companies that make a profit every year, in good times and bad." },
  { title: "A good company isn't always a good buy", text: "These report cards tell you how healthy a business is, not whether its shares are cheap. A wonderful company can be so expensive that it's a poor investment. Always check the price tag too." },
  { title: "Green flags and red flags", text: "No company is perfect, and one red flag isn't a verdict. What matters is the overall picture: several red flags together, or a red flag in the thing the company depends on most, deserve a closer look." },
  { title: "Banks are different", text: "A bank's raw material is money itself: it borrows from savers and lends to others. So the usual debt and cash tests don't apply to banks and insurers, and this site judges them on growth, profitability and steadiness." },
];

const GLOSSARY = [
  ["Sales (revenue)", "All the money customers paid the company, before any costs."],
  ["Profit (net income)", "What's left of sales after every cost, interest and tax."],
  ["Loss", "When costs are bigger than sales, so profit is negative."],
  ["Profit margin", "Profit ÷ sales. How much of each sale the company keeps."],
  ["Operating profit", "Profit from the day-to-day business, before interest and tax."],
  ["Return on equity (ROE)", "Profit ÷ owners' money. How hard the company works the money invested in it."],
  ["Cash flow", "Actual money coming in and going out, as opposed to accounting profit."],
  ["Free cash flow", "Cash from the business minus spending on equipment and buildings. The spare cash."],
  ["Debt-to-equity", "Borrowed money ÷ owners' money. Lower is safer."],
  ["Net cash", "More cash in the bank than total debt."],
  ["Interest cover", "Operating profit ÷ interest bill. How easily the company pays its lenders."],
  ["Equity", "What the company owns minus what it owes. The shareholders' part."],
  ["Dilution", "When a company issues new shares, making each existing share a smaller slice."],
  ["Buyback", "When a company buys its own shares, making each remaining share a bigger slice."],
  ["Dividend", "Cash a company pays its shareholders out of profit."],
  ["Quarter", "Three months. Most companies report every quarter; some only every six months."],
  ["Year on year", "Compared with the same period one year earlier."],
  ["P/E ratio", "Share price ÷ profit per share. How many years of today's profit you pay for a share."],
  ["Market value (market cap)", "Share price × number of shares. What the whole company is worth on the stock market."],
];
