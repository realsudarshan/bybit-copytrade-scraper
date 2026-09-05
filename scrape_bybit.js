const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());
const puppeteer = require('puppeteer');

async function run() {
    console.log("Launching browser...");
    const browser = await puppeteerExtra.launch({
        headless: "new",
        executablePath: puppeteer.executablePath(),
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    
    // We will collect the data by intercepting the JSON response.
    let leaderboardData = null;
    
    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('leaderboard') || url.includes('copy-trade') || url.includes('beehive') || url.includes('api2.bybit.com')) {
            try {
                if (response.request().resourceType() === 'fetch' || response.request().resourceType() === 'xhr') {
                    const json = await response.json();
                    if (json && json.result && json.result.list) {
                        leaderboardData = json.result.list;
                        console.log(`Intercepted API: ${url}`);
                    } else if (json && json.result && Array.isArray(json.result)) {
                        leaderboardData = json.result;
                        console.log(`Intercepted API: ${url}`);
                    }
                }
            } catch (e) {
            }
        }
    });

    console.log("Navigating to Bybit Copy Trade...");
    await page.goto('https://www.bybit.com/en/copyTrade/', { waitUntil: 'networkidle2', timeout: 60000 });
    
    console.log("Waiting for 10 seconds to ensure data loads...");
    await new Promise(r => setTimeout(r, 10000));

    if (leaderboardData) {
        console.log("\n--- EXTRACTED TRADER DATA FROM API ---");
        const top5 = leaderboardData.slice(0, 5);
        top5.forEach((trader, i) => {
            console.log(`${i+1}. Name: ${trader.nickName || trader.leaderName || trader.userName || 'Unknown'}`);
            console.log(`   ID: ${trader.leaderUserId || trader.userId || 'Unknown'}`);
            console.log(`   ROI: ${trader.roi || trader.roi30d || trader.roiE8 || 'Unknown'}`);
            console.log(`   Followers: ${trader.followerCount || trader.followers || trader.followerNum || 'Unknown'}`);
            console.log(`   Win Rate: ${trader.winRate || trader.winRatio || trader.winRateE4 || 'Unknown'}`);
            console.log(`   URL: https://www.bybit.com/en/copyTrade/trade-center/detail?leaderMark=${trader.leaderMark}`);
        });
        console.log(`Total traders intercepted in response: ${leaderboardData.length}`);
    } else {
        console.log("Could not intercept API response. Attempting to scrape DOM...");
        const traders = await page.evaluate(() => {
            const results = [];
            const cards = document.querySelectorAll('.leader-card, .trader-item, tr');
            for (let card of cards) {
                const text = card.innerText;
                if (text && (text.includes('ROI') || text.includes('Followers'))) {
                    results.push(text.replace(/\n/g, ' | '));
                }
            }
            return results.slice(0, 5);
        });
        console.log("DOM Scrape (Raw Text of top 5 elements):");
        console.log(traders);
    }

    await browser.close();
}

run().catch(console.error);
