# Report Radar

Plain-language readings of the financial reports of listed companies worldwide. Each company gets a health score out of 100 and a list of **green flags** and **red flags**, worded for someone who has never read a financial report.

Live site: https://irenemulia.github.io/report-radar/

## How it works

- `pipeline/build.py` runs four times a day via GitHub Actions (`.github/workflows/daily.yml`). It:
  1. builds a directory of listed companies from Yahoo Finance's screener: companies worth more than about US$200 million on the world's main stock markets;
  2. reads a batch of them with `yfinance` (companies whose results date has just passed first, then never-analysed companies, largest first, then the ones whose analysis is oldest);
  3. scores each one on five checks (growth, profitability, real cash, debt, steadiness) and raises green and red flags;
  4. compares the result with the previous analysis and writes the daily feed: fresh reports, flags that appeared or cleared, and results dates coming up.
- `docs/` is the static site: no build step, no framework. All plain-language text lives in `docs/explain.js`.
- The site and its data are published to the `gh-pages` branch, which is rebuilt from scratch on every run. Data is not committed to `main`.

## Running it yourself

- On GitHub: Actions → Update site → Run workflow
- Locally (Python 3.9+): `pip install -r pipeline/requirements.txt`, then `python pipeline/build.py AAPL 7203.T` to analyse a few symbols, or `python pipeline/build.py --no-fetch` to rebuild the index from saved data.

Educational tool, not financial advice.
