const express = require('express');
const puppeteer = require('puppeteer');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3002;





// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve your frontend files

// Create temp directory for storing images
const tempDir = path.join(__dirname, 'temp');
fs.mkdir(tempDir, { recursive: true }).catch(console.error);

class VintedScraper {
    constructor() {
        this.browser = null;
    }

async init() {
    this.browser = await puppeteer.launch({
        headless: 'new',  // This fixes the deprecation warning too
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor'
        ]
        // Remove any executablePath - let Puppeteer use its bundled Chrome
    });
}

    async close() {
        if (this.browser) {
            await this.browser.close();
        }
    }

    async scrapeListing(url) {
        if (!this.browser) {
            await this.init();
        }

        const page = await this.browser.newPage();
        
        try {
            // Set user agent to avoid detection
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
            
            // Navigate to the listing
            await page.goto(url, { 
                waitUntil: 'networkidle2',
                timeout: 30000 
            });

            // Wait for images to load
            await page.waitForSelector('img', { timeout: 10000 });

            // Extract listing data
            const listingData = await page.evaluate(() => {
                // Helper functions defined inside the evaluate context
                function isProductImage(src) {
                    // More lenient filtering - just exclude obvious non-product images
                    const excludeTerms = [
                        'avatar', 'logo', 'profile', 'user-', 'member-', 'badge', 'icon-',
                        'header', 'footer', 'navigation', 'nav-', 'menu', 'button'
                    ];
                    
                    const srcLower = src.toLowerCase();
                    return !excludeTerms.some(term => srcLower.includes(term));
                }

                function cleanImageUrl(src) {
                    // For Vinted URLs, preserve query parameters as they contain authentication signatures
                    // Only remove trailing colons and size parameters from the path, not query strings
                    let cleanSrc = src.replace(/_\d+x\d+/, '').replace(/:$/, '');
                    
                    // Don't modify Vinted URLs with query parameters as they need authentication
                    // The original URLs with /t/ and /f800/ and query parameters should work
                    return cleanSrc;
                }

                // Get the title
                let title = '';
                const titleSelectors = [
                    'h1[data-testid="item-title"]',
                    'h1.item-title',
                    '[data-testid="item-title"]',
                    'h1',
                    '.item-title',
                    '.item-box h1',
                    '.ItemBox-title'
                ];
                
                for (const selector of titleSelectors) {
                    const titleElement = document.querySelector(selector);
                    if (titleElement) {
                        title = titleElement.textContent.trim();
                        break;
                    }
                }

                // Get product images with multiple strategies
                const imageUrls = new Set();
                
                console.log('Starting image search...');

                // Strategy 1: Look for specific product image selectors
                const productImageSelectors = [
                    'img[data-testid="item-photo"]',
                    '[data-testid="item-photos"] img',
                    '[data-testid="carousel"] img',
                    '.item-photos img',
                    '.carousel img',
                    '.ItemPhotos img',
                    '.item-photo img'
                ];

                for (const selector of productImageSelectors) {
                    const images = document.querySelectorAll(selector);
                    console.log(`Found ${images.length} images with selector: ${selector}`);
                    
                    images.forEach(img => {
                        const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-original');
                        if (src && isProductImage(src)) {
                            let cleanSrc = cleanImageUrl(src);
                            imageUrls.add(cleanSrc);
                            console.log('Added product image:', cleanSrc);
                        }
                    });
                    
                    if (imageUrls.size > 0) {
                        console.log(`Found ${imageUrls.size} images with strategy 1`);
                        break;
                    }
                }

                // Strategy 2: If no images found, look for any vinted images but filter out unwanted ones
                if (imageUrls.size === 0) {
                    console.log('Strategy 1 failed, trying strategy 2...');
                    const allImages = document.querySelectorAll('img[src*="vinted"]');
                    console.log(`Found ${allImages.length} total vinted images`);
                    
                    allImages.forEach(img => {
                        const src = img.src;
                        if (src && isProductImage(src)) {
                            let cleanSrc = cleanImageUrl(src);
                            imageUrls.add(cleanSrc);
                            console.log('Added image from strategy 2:', cleanSrc);
                        }
                    });
                }

                // Strategy 3: Even more relaxed - just avoid obvious non-product images
                if (imageUrls.size === 0) {
                    console.log('Strategy 2 failed, trying strategy 3...');
                    const allImages = document.querySelectorAll('img');
                    
                    allImages.forEach(img => {
                        const src = img.src || img.getAttribute('data-src');
                        if (src && src.includes('vinted') && 
                            !src.includes('avatar') && 
                            !src.includes('logo') && 
                            !src.includes('profile') &&
                            img.width > 100 && img.height > 100) { // Only larger images
                            
                            let cleanSrc = cleanImageUrl(src);
                            imageUrls.add(cleanSrc);
                            console.log('Added image from strategy 3:', cleanSrc);
                        }
                    });
                }

                console.log(`Final image count: ${imageUrls.size}`);

                return {
                    title: title || 'Vinted Listing',
                    images: Array.from(imageUrls).slice(0, 20),
                    debugInfo: {
                        totalImagesFound: imageUrls.size,
                        strategies: ['product-selectors', 'vinted-filter', 'size-filter']
                    }
                };
            });

            await page.close();
            return listingData;

        } catch (error) {
            await page.close();
            throw error;
        }
    }
}

// Global scraper instance
const scraper = new VintedScraper();

// Utility function to download image and convert to PNG
async function downloadImage(url, filename) {
    try {
        // Remove trailing colon if present but preserve query parameters for authentication
        const cleanUrl = url.replace(/:$/, '');
        
        console.log(`Downloading image from: ${cleanUrl}`);
        const response = await axios({
            method: 'GET',
            url: cleanUrl,
            responseType: 'stream',
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'image/*,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Cache-Control': 'no-cache',
                'Referer': 'https://www.vinted.dk/'
            }
        });

        const writer = require('fs').createWriteStream(filename);
        response.data.pipe(writer);
        
        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (error) {
        console.error(`Failed to download image from ${url}:`, error.message);
        throw error;
    }
}

// Utility function to sanitize filename
function sanitizeFilename(filename) {
    return filename
        .replace(/[<>:"/\\|?*]/g, '') // Remove invalid characters
        .replace(/\s+/g, '_') // Replace spaces with underscores
        .replace(/[^\w\-_.]/g, '') // Keep only word characters, hyphens, underscores, dots
        .substring(0, 50) // Limit length
        .replace(/^\.+|\.+$/g, ''); // Remove leading/trailing dots
}

// API Routes
app.post('/api/extract-images', async (req, res) => {
    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // Validate Vinted URL
        const urlObj = new URL(url);
        if (!urlObj.hostname.includes('vinted')) {
            return res.status(400).json({ error: 'Please provide a valid Vinted URL' });
        }

        console.log(`Scraping listing: ${url}`);

        // Scrape the listing
        const listingData = await scraper.scrapeListing(url);

        if (!listingData.images || listingData.images.length === 0) {
            return res.status(404).json({ error: 'No images found in the listing' });
        }

        console.log(`Found ${listingData.images.length} images for: ${listingData.title}`);

        // Create unique session ID for this request
        const sessionId = uuidv4();
        const sessionDir = path.join(tempDir, sessionId);
        await fs.mkdir(sessionDir, { recursive: true });

        // Download all images as PNG
        const downloadPromises = listingData.images.map(async (imageUrl, index) => {
            try {
                // Try different URL formats if the original URL fails
                let filename = path.join(sessionDir, `image_${index + 1}.png`);
                try {
                    // First try the original URL (with trailing colon removed)
                    await downloadImage(imageUrl, filename);
                    return filename;
                } catch (error) {
                    console.error(`Failed with original URL, trying alternative formats...`);
                    
                    // Try removing the /t/ path segment which might be causing issues
                    const altUrl1 = imageUrl.replace(/\/t\/([^/]+)\//, '//');
                    try {
                        await downloadImage(altUrl1, filename);
                        console.log(`Successfully downloaded with alternative URL format 1: ${altUrl1}`);
                        return filename;
                    } catch (error2) {
                        // Try a completely different format
                        const altUrl2 = imageUrl.replace(/\/t\/([^/]+)\/f800\//, '//');
                        try {
                            await downloadImage(altUrl2, filename);
                            console.log(`Successfully downloaded with alternative URL format 2: ${altUrl2}`);
                            return filename;
                        } catch (error3) {
                            console.error(`Failed to download image ${index + 1} after trying all URL formats:`, error.message);
                            return null;
                        }
                    }
                }
            } catch (error) {
                console.error(`Failed to download image ${index + 1}:`, error.message);
                return null;
            }
        });

        const downloadedFiles = (await Promise.allSettled(downloadPromises))
            .filter(result => result.status === 'fulfilled' && result.value)
            .map(result => result.value);

        if (downloadedFiles.length === 0) {
            return res.status(500).json({ error: 'Failed to download any images' });
        }

        // Create ZIP file
        const zipFilename = path.join(sessionDir, 'images.zip');
        const output = require('fs').createWriteStream(zipFilename);
        const archive = archiver('zip', { zlib: { level: 9 } });

        archive.on('error', (err) => {
            throw err;
        });

        archive.pipe(output);

        // Add files to ZIP
        for (const filePath of downloadedFiles) {
            const filename = path.basename(filePath);
            archive.file(filePath, { name: filename });
        }

        await archive.finalize();

        // Wait for ZIP to be written
        await new Promise((resolve) => {
            output.on('close', resolve);
        });

        // Save the title for the download filename
        const titleFile = path.join(sessionDir, 'title.txt');
        await fs.writeFile(titleFile, listingData.title, 'utf8');

        console.log(`Created ZIP file with ${downloadedFiles.length} images`);

        // Send response with download URL and sanitized title
        res.json({
            success: true,
            title: listingData.title,
            imageCount: downloadedFiles.length,
            downloadUrl: `/api/download/${sessionId}`,
            sanitizedTitle: sanitizeFilename(listingData.title) // Send sanitized title to frontend
        });

        // Clean up individual image files (keep only ZIP)
        for (const filePath of downloadedFiles) {
            try {
                await fs.unlink(filePath);
            } catch (error) {
                console.error('Failed to delete temp file:', error.message);
            }
        }

        // Schedule cleanup of session directory after 1 hour
        setTimeout(async () => {
            try {
                await fs.rm(sessionDir, { recursive: true, force: true });
                console.log(`Cleaned up session: ${sessionId}`);
            } catch (error) {
                console.error('Failed to cleanup session:', error.message);
            }
        }, 60 * 60 * 1000);

    } catch (error) {
        console.error('Error processing request:', error.message);
        res.status(500).json({ 
            error: 'Failed to process the listing. Please check the URL and try again.' 
        });
    }
});

app.get('/api/download/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const sessionDir = path.join(tempDir, sessionId);
        const zipFilename = path.join(sessionDir, 'images.zip');

        // Check if file exists
        try {
            await fs.access(zipFilename);
        } catch (error) {
            return res.status(404).json({ error: 'Download not found or expired' });
        }

        // Read the title from a temporary file we'll create during processing
        let downloadFilename = 'vinted_images.zip';
        try {
            const titleFile = path.join(sessionDir, 'title.txt');
            const title = await fs.readFile(titleFile, 'utf8');
            downloadFilename = `${sanitizeFilename(title)}.zip`;
        } catch (error) {
            console.log('Could not read title file, using default name');
        }

        // Send the ZIP file with the listing title as filename
        res.download(zipFilename, downloadFilename, (error) => {
            if (error) {
                console.error('Download error:', error.message);
                res.status(500).json({ error: 'Failed to download file' });
            }
        });

    } catch (error) {
        console.error('Download error:', error.message);
        res.status(500).json({ error: 'Failed to process download' });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    await scraper.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Shutting down gracefully...');
    await scraper.close();
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`🚀 Vinted Image Downloader API running on port ${PORT}`);
    console.log(`📋 Health check: http://localhost:${PORT}/api/health`);
});
