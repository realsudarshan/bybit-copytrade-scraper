const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const fs = require('fs');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const LEADERBOARD_PAGES  = 10;   // 10 pages × 16 = 160 traders. Max: 476 pages (7,602 traders)
const PAGE_SIZE          = 16;
const DETAIL_BATCH_SIZE  = 5;    // How many traders to fetch details for (set higher for more)
const DELAY_MS           = 800;
// ─────────────────────────────────────────────────────────────────────────────

// ─── INDIVIDUAL TRADER ENDPOINTS ─────────────────────────────────────────────
// All discovered by intercepting Bybit's own frontend calls:
//
// 1. /pub-leader/info          → basic profile (name, avatar, status, follower count)
// 2. /leader-income            → MASSIVE stats (ROI, PnL, Win Rate, Drawdown, Sharpe, Sortino,
//                                  for 7d/30d/90d, trade count, avg position time, etc.)
// 3. /position/list            → current open positions
// 4. /traded-symbols           → which symbols they trade
// 5. /yield-trend              → daily PnL chart data
// 6. /dynamic-yield-trend      → yield trend with metrics
// 7. /other-follower           → list of followers
// 8. /identify-tag-info        → trader level, VIP status, country
// ─────────────────────────────────────────────────────────────────────────────

const METRIC_COLS = ['roi', 'drawdown', 'followerProfit', 'winRate', 'profitLossRatio', 'sharpeRatio'];

function parseLeaderboardTrader(raw) {
    const mv = raw.metricValues || [];
    const metrics = {};
    METRIC_COLS.forEach((key, i) => { metrics[key] = mv[i] || 'N/A'; });
    return {
        nickname:        raw.nickName        || 'Unknown',
        traderId:        raw.leaderUserId    || 'Unknown',
        leaderMark:      raw.leaderMark      || 'Unknown',
        countryCode:     raw.countryCode     || 'N/A',
        leaderLevel:     (raw.leaderLevel || '').replace('COPY_TRADE_LEADER_LEVEL_', ''),
        roi30d:          metrics.roi,
        drawdown30d:     metrics.drawdown,
        winRate:         metrics.winRate,
        sharpeRatio:     metrics.sharpeRatio,
        followerProfit:  metrics.followerProfit,
        profitLossRatio: metrics.profitLossRatio,
        followers:       raw.currentFollowerCount ?? 'N/A',
        maxFollowers:    raw.maxFollowerCount      ?? 'N/A',
        profileUrl:      `https://www.bybit.com/en/copyTrade/trade-center/detail?leaderMark=${raw.leaderMark || raw.leaderUserId}`,
    };
}

async function fetchTraderDetail(page, leaderMark) {
    const encoded = encodeURIComponent(leaderMark);

    const [infoJson, incomeJson, positionsJson, symbolsJson] = await page.evaluate(async (mark) => {
        const headers = { 'Accept': 'application/json' };
        const opts = { method: 'GET', credentials: 'include', headers };
        const base = 'https://www.bybit.com/x-api/fapi/beehive';

        const [info, income, positions, symbols] = await Promise.all([
            fetch(`${base}/private/v1/pub-leader/info?leaderMark=${mark}`, opts).then(r => r.json()).catch(() => null),
            fetch(`${base}/public/v1/common/leader-income?leaderMark=${mark}`, opts).then(r => r.json()).catch(() => null),
            fetch(`${base}/public/v1/common/position/list?leaderMark=${mark}`, opts).then(r => r.json()).catch(() => null),
            fetch(`${base}/private/v1/common/traded-symbols?leaderMark=${mark}`, opts).then(r => r.json()).catch(() => null),
        ]);
        return [info, income, positions, symbols];
    }, encoded);

    const info   = infoJson?.result   || {};
    const income = incomeJson?.result || {};
    const pos    = positionsJson?.result?.data || [];
    const syms   = symbolsJson?.result?.symbols || [];

    // Parse the massive income data into clean fields
    const e4  = (v) => v != null ? (parseFloat(v) / 1e4 * 100).toFixed(2) + '%' : 'N/A';
    const e8  = (v) => v != null ? (parseFloat(v) / 1e8).toFixed(4) : 'N/A';
    const raw = (v) => v != null ? v : 'N/A';

    return {
        // ── Basic info ──
        nickname:          info.leaderUserName       || 'Unknown',
        traderId:          info.leaderUserId          || 'Unknown',
        leaderMark:        info.leaderMark            || leaderMark,
        avatar:            info.leaderUserAvatar      || '',
        introduction:      info.leaderUserIntroduction || '',
        followersCurrent:  raw(info.currentFollowerCount),
        followersMax:      raw(info.maxFollowerCount),
        followersTotal:    raw(info.cumFollowerCount),
        tradeDays:         raw(info.tradeDays),
        locateDays:        raw(info.locateDays),
        aum:               e8(info.aumE8),

        // ── ROI (multiple periods) ──
        roi7d:             e4(income.sevenDayYieldRateE4),
        roi30d:            e4(income.thirtyDayYieldRateE4),
        roi90d:            e4(income.ninetyDayYieldRateE4),
        roiAllTime:        e4(income.cumYieldRateE4),

        // ── Win Rate (multiple periods) ──
        winRate7d:         e4(income.sevenDayProfitWinRateE4),
        winRate30d:        e4(income.thirtyDayProfitWinRateE4),
        winRate90d:        e4(income.ninetyDayProfitWinRateE4),

        // ── Max Drawdown ──
        drawdown7d:        e4(income.sevenDayDrawDownE4),
        drawdown30d:       e4(income.thirtyDayDrawDownE4),
        drawdown90d:       e4(income.ninetyDayDrawDownE4),

        // ── Sharpe Ratio ──
        sharpe7d:          income.sevenDaySharpeRatioE4  != null ? (parseFloat(income.sevenDaySharpeRatioE4)  / 1e4).toFixed(4) : 'N/A',
        sharpe30d:         income.thirtyDaySharpeRatioE4 != null ? (parseFloat(income.thirtyDaySharpeRatioE4) / 1e4).toFixed(4) : 'N/A',
        sharpe90d:         income.ninetyDaySharpeRatioE4 != null ? (parseFloat(income.ninetyDaySharpeRatioE4) / 1e4).toFixed(4) : 'N/A',

        // ── Sortino Ratio ──
        sortino7d:         income.sevenDaySortinoRatioE4  != null ? (parseFloat(income.sevenDaySortinoRatioE4)  / 1e4).toFixed(4) : 'N/A',
        sortino30d:        income.thirtyDaySortinoRatioE4 != null ? (parseFloat(income.thirtyDaySortinoRatioE4) / 1e4).toFixed(4) : 'N/A',
        sortino90d:        income.ninetyDaySortinoRatioE4 != null ? (parseFloat(income.ninetyDaySortinoRatioE4) / 1e4).toFixed(4) : 'N/A',

        // ── PnL ──
        pnl7d:             e8(income.sevenDayProfitE8),
        pnl30d:            e8(income.thirtyDayProfitE8),
        pnl90d:            e8(income.ninetyDayProfitE8),
        pnlAllTime:        e8(income.cumYieldE8),
        followerPnlAllTime:e8(income.cumFollowerYieldE8),

        // ── Trade Stats ──
        totalTrades:       raw(income.cumTradeCount),
        totalWins:         raw(income.cumWinCount),
        totalLosses:       raw(income.cumLossCount),
        avgPositionTime:   raw(income.avePositionTime),
        avgWeeklyTrades:   income.weekTradeCountE2 != null ? (parseFloat(income.weekTradeCountE2) / 100).toFixed(2) : 'N/A',
        lastTradeTime:     income.recentTradeTimeE3 ? new Date(parseInt(income.recentTradeTimeE3)).toISOString() : 'N/A',

        // ── Current Open Positions ──
        openPositions: pos.map(p => ({
            symbol:      p.symbol,
            side:        p.side,
            size:        p.sizeX,
            entryPrice:  p.entryPriceE8 ? (parseFloat(p.entryPriceE8) / 1e8).toFixed(4) : p.entryPrice,
            markPrice:   p.markPriceE8  ? (parseFloat(p.markPriceE8)  / 1e8).toFixed(4) : p.markPrice,
            leverage:    p.leverageE2   ? (parseFloat(p.leverageE2)   / 100).toFixed(1) + 'x' : p.leverage,
            unrealizedPnl: p.unrealisedPnlE8 ? (parseFloat(p.unrealisedPnlE8) / 1e8).toFixed(4) : p.unrealisedPnl,
            createdAt:   p.createdAtE3 ? new Date(parseInt(p.createdAtE3)).toISOString() : 'N/A',
        })),

        // ── Traded Symbols ──
        tradedSymbols: syms,

        profileUrl: `https://www.bybit.com/en/copyTrade/trade-center/detail?leaderMark=${leaderMark}`,
    };
}

async function run() {
    console.log('Launching browser...');
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    // ── Step 1: Akamai clearance ──
    console.log('Getting Akamai session...');
    try {
        await page.goto('https://www.bybit.com/en/copyTrade/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch(e) {}
    await page.waitForTimeout(10000);
    console.log('Session ready!\n');

    // ── Step 2: Fetch leaderboard (all fields including Win Rate) ──
    console.log(`Fetching leaderboard (${LEADERBOARD_PAGES} pages × ${PAGE_SIZE})...\n`);
    const allTraders = [];
    for (let p = 1; p <= LEADERBOARD_PAGES; p++) {
        const json = await page.evaluate(async (params) => {
            const url = `https://www.bybit.com/x-api/fapi/beehive/public/v1/common/dynamic-leader-list?pageNo=${params.p}&pageSize=${params.ps}&userTag=&dataDuration=DATA_DURATION_THIRTY_DAY&leaderTag=&code=&leaderLevel=`;
            const res = await fetch(url, { method: 'GET', credentials: 'include', headers: { 'Accept': 'application/json' } });
            return res.json();
        }, { p, ps: PAGE_SIZE });

        const list = json?.result?.leaderDetails || [];
        if (!list.length) { console.log(`  Page ${p}: empty — done.`); break; }
        allTraders.push(...list.map(parseLeaderboardTrader));
        console.log(`  Page ${p}/${LEADERBOARD_PAGES}: ✓ ${list.length} traders (total: ${allTraders.length})`);
        if (p < LEADERBOARD_PAGES) await page.waitForTimeout(DELAY_MS);
    }

    // ── Step 3: Fetch individual trader details (deep data) ──
    const tradersToDetail = allTraders.slice(0, DETAIL_BATCH_SIZE);
    console.log(`\nFetching deep details for top ${tradersToDetail.length} traders...\n`);
    const detailedTraders = [];
    for (let i = 0; i < tradersToDetail.length; i++) {
        const t = tradersToDetail[i];
        console.log(`  [${i+1}/${tradersToDetail.length}] Fetching ${t.nickname}...`);
        try {
            const detail = await fetchTraderDetail(page, t.leaderMark);
            detailedTraders.push(detail);
            console.log(`    ✓ ROI: 7d=${detail.roi7d} 30d=${detail.roi30d} 90d=${detail.roi90d} | WR: ${detail.winRate30d} | Positions: ${detail.openPositions.length} | Symbols: ${detail.tradedSymbols.length}`);
        } catch(e) {
            console.log(`    ✗ Error: ${e.message}`);
        }
        await page.waitForTimeout(DELAY_MS);
    }

    await browser.close();

    // ── Step 4: Save everything ──
    const output = {
        scrapedAt:      new Date().toISOString(),
        leaderboard:    allTraders,
        detailedTraders: detailedTraders,
        summary: {
            totalLeaderboard: allTraders.length,
            totalDetailed:    detailedTraders.length,
            availableOnBybit: 7602,
        },
    };

    const outPath = 'C:\\scrape\\bybit_full_data.json';
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

    // ── Step 5: Print summary ──
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`✅  DONE — ${output.scrapedAt}`);
    console.log(`   Leaderboard traders : ${allTraders.length}`);
    console.log(`   Detailed profiles   : ${detailedTraders.length}`);
    console.log(`   Saved to            : ${outPath}`);
    console.log('═══════════════════════════════════════════════════════════');

    if (detailedTraders.length > 0) {
        console.log('\n══════════ SAMPLE DETAILED TRADER PROFILE ══════════');
        const d = detailedTraders[0];
        console.log(`  Nickname         : ${d.nickname}`);
        console.log(`  Introduction     : ${d.introduction || '(none)'}`);
        console.log(`  Trading Days     : ${d.tradeDays}`);
        console.log(`  AUM              : ${d.aum} USDT`);
        console.log(`  ─── ROI ───`);
        console.log(`    7d             : ${d.roi7d}`);
        console.log(`    30d            : ${d.roi30d}`);
        console.log(`    90d            : ${d.roi90d}`);
        console.log(`    All-time       : ${d.roiAllTime}`);
        console.log(`  ─── Win Rate ───`);
        console.log(`    7d             : ${d.winRate7d}`);
        console.log(`    30d            : ${d.winRate30d}`);
        console.log(`    90d            : ${d.winRate90d}`);
        console.log(`  ─── Drawdown ───`);
        console.log(`    7d             : ${d.drawdown7d}`);
        console.log(`    30d            : ${d.drawdown30d}`);
        console.log(`    90d            : ${d.drawdown90d}`);
        console.log(`  ─── Sharpe / Sortino ───`);
        console.log(`    Sharpe 30d     : ${d.sharpe30d}`);
        console.log(`    Sortino 30d    : ${d.sortino30d}`);
        console.log(`  ─── Trade Stats ───`);
        console.log(`    Total trades   : ${d.totalTrades}`);
        console.log(`    Wins / Losses  : ${d.totalWins} / ${d.totalLosses}`);
        console.log(`    Avg weekly     : ${d.avgWeeklyTrades} trades`);
        console.log(`    Avg hold time  : ${d.avgPositionTime}`);
        console.log(`    Last trade     : ${d.lastTradeTime}`);
        console.log(`  ─── PnL ───`);
        console.log(`    30d PnL        : ${d.pnl30d} USDT`);
        console.log(`    All-time PnL   : ${d.pnlAllTime} USDT`);
        console.log(`    Follower PnL   : ${d.followerPnlAllTime} USDT`);
        console.log(`  ─── Open Positions (${d.openPositions.length}) ───`);
        d.openPositions.slice(0, 5).forEach(p => {
            console.log(`    ${p.symbol} ${p.side} ${p.size} @ ${p.entryPrice} (${p.leverage}) PnL: ${p.unrealizedPnl}`);
        });
        console.log(`  ─── Traded Symbols (${d.tradedSymbols.length}) ───`);
        console.log(`    ${d.tradedSymbols.slice(0, 10).join(', ')}${d.tradedSymbols.length > 10 ? '...' : ''}`);
        console.log(`  Profile URL      : ${d.profileUrl}`);
        console.log('═══════════════════════════════════════════════════════════');
    }
}

run().catch(console.error);
