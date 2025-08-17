const puppeteer = require('puppeteer');

async function installChrome() {
    try {
        console.log('Installing Chrome for Puppeteer...');
        
        // This will automatically download Chrome if it doesn't exist
        const browserFetcher = puppeteer.createBrowserFetcher();
        const revisionInfo = await browserFetcher.download('121.0.6167.85');
        
        console.log('Chrome installed at:', revisionInfo.executablePath);
        console.log('Chrome installation completed successfully!');
        
    } catch (error) {
        console.error('Failed to install Chrome:', error);
        process.exit(1);
    }
}

installChrome();