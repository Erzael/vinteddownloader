const { execSync } = require('child_process');

async function installChrome() {
    try {
        console.log('Installing Chrome for Puppeteer...');
        
        // Use the official Puppeteer CLI command but with explicit node execution
        console.log('Running: node node_modules/puppeteer/install.js');
        execSync('node node_modules/puppeteer/install.js', { 
            stdio: 'inherit',
            timeout: 300000 // 5 minutes
        });
        
        console.log('Chrome installation completed successfully!');
        
    } catch (error) {
        console.error('Chrome installation failed, trying alternative method...');
        
        try {
            // Alternative: Try to launch Puppeteer which will auto-download Chrome
            const puppeteer = require('puppeteer');
            console.log('Attempting to auto-download Chrome by launching Puppeteer...');
            
            const browser = await puppeteer.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            
            console.log('Chrome auto-download successful!');
            await browser.close();
            
        } catch (launchError) {
            console.error('All Chrome installation methods failed:', launchError);
            process.exit(1);
        }
    }
}

installChrome();
