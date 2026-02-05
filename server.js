require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

// Validate Cloudinary configuration
// Support both signed (with API secret) and unsigned (with upload preset) uploads
// Note: API key is required for both modes, but API secret is only needed for signed uploads
const useUnsignedUpload = !!process.env.CLOUDINARY_UPLOAD_PRESET;
const useSignedUpload = process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET;

if (!process.env.CLOUDINARY_CLOUD_NAME) {
  console.error('ERROR: Missing CLOUDINARY_CLOUD_NAME in .env file');
  process.exit(1);
}

if (!process.env.CLOUDINARY_API_KEY) {
  console.error('ERROR: Missing CLOUDINARY_API_KEY in .env file');
  console.error('API key is required for both signed and unsigned uploads');
  process.exit(1);
}

if (!useUnsignedUpload && !useSignedUpload) {
  console.error('ERROR: Missing Cloudinary authentication configuration');
  console.error('Please set either:');
  console.error('  - CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET (for signed uploads), OR');
  console.error('  - CLOUDINARY_API_KEY and CLOUDINARY_UPLOAD_PRESET (for unsigned uploads)');
  process.exit(1);
}

// Initialize Cloudinary
// API key is always required, API secret is only needed for signed uploads
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  ...(useSignedUpload && {
    api_secret: process.env.CLOUDINARY_API_SECRET
  })
});

// Log configuration status (without exposing secrets)
console.log('Cloudinary Configuration:');
console.log(`  Cloud Name: ${process.env.CLOUDINARY_CLOUD_NAME}`);
console.log(`  API Key: ${process.env.CLOUDINARY_API_KEY ? 'SET' : 'NOT SET'}`);
console.log(`  Upload Mode: ${useUnsignedUpload ? 'Unsigned (using preset)' : 'Signed (using API key + secret)'}`);
if (useUnsignedUpload) {
  console.log(`  Upload Preset: ${process.env.CLOUDINARY_UPLOAD_PRESET || 'NOT SET'}`);
} else {
  console.log(`  API Secret: ${process.env.CLOUDINARY_API_SECRET ? 'SET' : 'NOT SET'}`);
}

const app = express();
const PORT = process.env.PORT || 3000;

// CORS: restrict to Canva app origin in production; falls back to * for local dev
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "").toLowerCase();
if (!ALLOWED_ORIGIN) {
  console.warn('WARNING: ALLOWED_ORIGIN is not set. Falling back to allow all origins.');
}
app.use(cors({
  origin: ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

// Diagnostic endpoint to check Cloudinary configuration (before static files)
app.get('/api/health', (req, res) => {
  const config = {
    cloudinary_configured: !!process.env.CLOUDINARY_CLOUD_NAME,
    upload_mode: useUnsignedUpload ? 'unsigned' : 'signed',
    has_cloud_name: !!process.env.CLOUDINARY_CLOUD_NAME,
    has_api_key: !!process.env.CLOUDINARY_API_KEY,
    has_api_secret: !!process.env.CLOUDINARY_API_SECRET,
    has_upload_preset: !!process.env.CLOUDINARY_UPLOAD_PRESET
  };
  res.json(config);
});

// Serve static files from desktop/public directory
app.use(express.static('desktop/public'));

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per file
    fieldSize: 50 * 1024 * 1024 // 50MB total
  }
});

// Helper function to check if file is an image
function isImageFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
}

// Normalize image path: strip leading ./ or ../, extract images/… segment, lowercase
function normalizeImagePath(p) {
  let n = p.replace(/^\.\.?\//, '').toLowerCase();
  const idx = n.indexOf('images/');
  if (idx > 0) n = n.substring(idx);
  return n;
}

// Helper function to upload image to Cloudinary (deduplicates by content hash)
async function uploadImageToCloudinary(buffer, filename) {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  const publicId = `emails/${hash}`;

  // Check if this exact image already exists on Cloudinary
  if (useSignedUpload) {
    try {
      const existing = await cloudinary.api.resource(publicId);
      console.log(`Reusing existing asset: ${existing.secure_url}`);
      return existing.secure_url;
    } catch (e) {
      const httpCode = e.http_code || (e.error && e.error.http_code);
      if (httpCode !== 404) throw e;
    }
  }

  return new Promise((resolve, reject) => {
    const uploadOptions = {
      public_id: publicId,
      resource_type: 'image',
    };

    if (useUnsignedUpload) {
      uploadOptions.upload_preset = process.env.CLOUDINARY_UPLOAD_PRESET;
    }

    console.log(`Uploading ${filename} as ${publicId} (${buffer.length} bytes)`);

    const uploadStream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error) {
          console.error('Cloudinary upload error:', error.message || error);
          reject(new Error(error.message || 'Upload failed'));
        } else if (!result || !result.secure_url) {
          reject(new Error('Upload succeeded but no URL returned from Cloudinary'));
        } else {
          console.log(`Uploaded ${filename}: ${result.secure_url}`);
          resolve(result.secure_url);
        }
      }
    );

    uploadStream.on('error', (streamError) => {
      console.error('Upload stream error:', streamError);
      reject(new Error(`Upload stream error: ${streamError.message || streamError}`));
    });

    uploadStream.end(buffer);
  });
}

// Error handler for multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 10MB per file.' });
    }
    if (err.code === 'LIMIT_FIELD_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Too many files uploaded.' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  if (err) {
    return res.status(400).json({ error: err.message || 'Upload error' });
  }
  next();
};

// Main processing endpoint
app.post('/api/process', upload.any(), handleMulterError, async (req, res) => {
  try {
    const files = req.files || [];
    
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // Find HTML file (prefer index.html, then email.html, then any .html)
    const htmlFile = files.find(file => {
      const name = file.originalname.toLowerCase();
      return name === 'index.html' || name.includes('index.html');
    }) || files.find(file => {
      const name = file.originalname.toLowerCase();
      return name === 'email.html' || name.includes('email.html');
    }) || files.find(file => {
      return file.originalname.toLowerCase().endsWith('.html');
    });

    if (!htmlFile) {
      return res.status(400).json({ error: 'No HTML file found. Please ensure your folder/ZIP contains an HTML file (index.html, email.html, etc.)' });
    }

    // Get HTML content
    let htmlContent;
    try {
      htmlContent = htmlFile.buffer.toString('utf-8');
      if (!htmlContent || htmlContent.trim().length === 0) {
        return res.status(400).json({ error: 'index.html file is empty' });
      }
    } catch (error) {
      return res.status(400).json({ error: 'Failed to read index.html file: ' + error.message });
    }

    // Filter image files (from images/ directory)
    // Handle both "images/filename.ext" and paths with backslashes "images\filename.ext"
    const imageFiles = files.filter(file => {
      if (!isImageFile(file.originalname)) {
        return false;
      }
      
      const normalizedPath = file.originalname.toLowerCase().replace(/\\/g, '/');
      const isInImagesDir = normalizedPath.includes('images/') || 
                           file.fieldname === 'images' ||
                           normalizedPath.startsWith('images/');
      
      return isInImagesDir;
    });

    if (imageFiles.length === 0) {
      return res.status(400).json({ error: 'No image files found in images/ directory' });
    }

    // Upload all images to Cloudinary (deduplicates by content hash)
    const imageUrlMap = {};
    
    for (const imageFile of imageFiles) {
      // Extract filename from path (handle both "images/filename.ext" and just "filename.ext")
      let filename = imageFile.originalname;
      if (filename.includes('/')) {
        filename = filename.substring(filename.lastIndexOf('/') + 1);
      }
      
      const imagePath = normalizeImagePath(`images/${filename}`);
      
      try {
        // Validate buffer exists and has content
        if (!imageFile.buffer || imageFile.buffer.length === 0) {
          return res.status(400).json({ 
            error: `Image file ${filename} is empty or corrupted` 
          });
        }

        const cloudinaryUrl = await uploadImageToCloudinary(
          imageFile.buffer,
          filename
        );
        imageUrlMap[imagePath] = cloudinaryUrl;
      } catch (error) {
        console.error(`Error uploading ${filename}:`, error);
        const errorMessage = error.message || (error.error && error.error.message) || JSON.stringify(error) || 'Unknown upload error';
        
        // Check for common Cloudinary errors
        if (errorMessage.includes('Invalid API Key') || errorMessage.includes('401')) {
          return res.status(500).json({ 
            error: `Cloudinary authentication failed. Please check your API credentials in .env file. Original error: ${errorMessage}` 
          });
        }
        if (errorMessage.includes('Invalid upload preset')) {
          return res.status(500).json({ 
            error: `Invalid Cloudinary upload preset. Please check CLOUDINARY_UPLOAD_PRESET in .env file. Original error: ${errorMessage}` 
          });
        }
        
        return res.status(500).json({ 
          error: `Failed to upload image ${filename}: ${errorMessage}` 
        });
      }
    }

    // Process HTML with cheerio
    let $;
    try {
      $ = cheerio.load(htmlContent, {
        decodeEntities: false,
        xmlMode: false
      });
    } catch (error) {
      return res.status(400).json({ error: 'Failed to parse HTML: ' + error.message });
    }

    // Replace image URLs in img tags
    $('img').each((i, elem) => {
      const $elem = $(elem);
      const src = $elem.attr('src');
      if (!src) return;

      const normalized = normalizeImagePath(src);
      if (normalized.startsWith('images/')) {
        const cloudinaryUrl = imageUrlMap[normalized];
        if (cloudinaryUrl) {
          $elem.attr('src', cloudinaryUrl);
        }
      }
    });

    // Replace image URLs in preload links
    $('link[rel="preload"][as="image"]').each((i, elem) => {
      const $elem = $(elem);
      const href = $elem.attr('href');
      if (!href) return;

      const normalized = normalizeImagePath(href);
      if (normalized.startsWith('images/')) {
        const cloudinaryUrl = imageUrlMap[normalized];
        if (cloudinaryUrl) {
          $elem.attr('href', cloudinaryUrl);
        }
      }
    });

    // Get processed HTML
    const processedHtml = $.html();

    // Return processed HTML
    res.json({ 
      html: processedHtml,
      imageCount: imageFiles.length,
      folder: 'emails'
    });

  } catch (error) {
    console.error('Processing error:', error);
    const errorMessage = error.message || (error.error && error.error.message) || JSON.stringify(error) || 'Internal server error';
    
    // Check if it's a Cloudinary error
    if (error.http_code) {
      return res.status(500).json({ 
        error: `Cloudinary error (${error.http_code}): ${error.message || 'Failed to upload images'}` 
      });
    }
    
    res.status(500).json({ error: errorMessage });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Serve frontend at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'desktop', 'public', 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Make sure to set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET in .env');
});
