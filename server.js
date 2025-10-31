'use strict';

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const archiver = require('archiver');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const crypto = require('crypto');

// -------- Config (env overrideable) --------
const PORT = process.env.PORT || 3000;
const MAX_FILES = parseInt(process.env.MAX_FILES || '50', 10);
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '50', 10); // per file
const DEFAULT_QUALITY = parseInt(process.env.DEFAULT_QUALITY || '80', 10);
const DEFAULT_EFFORT = parseInt(process.env.DEFAULT_EFFORT || '4', 10); // 0-6
const CONVERT_CONCURRENCY = parseInt(process.env.CONCURRENCY || '2', 10); // sequential/low concurrency helps memory usage

// Optimize sharp globally
try {
  sharp.concurrency(Math.max(1, Math.min(require('os').cpus().length, 6)));
  sharp.cache({ files: 20, memory: 300, items: 200 }); // tune for memory/mid workloads
} catch (_) {}

// -------- Helpers --------
const isImageMime = (mime) => /^image\/.+/i.test(mime || '');
const sanitizeFilename = (name) =>
  (name || 'image')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '_')
    .slice(0, 120);

const changeExtToWebp = (filename) => {
  const { name } = path.parse(filename);
  return `${sanitizeFilename(name || 'image')}.webp`;
};

async function convertBufferToWebp(buffer, opts) {
  // Rotate to respect EXIF orientation, sequential read saves memory on large images
  const pipeline = sharp(buffer, { sequentialRead: true }).rotate();
  const webpOptions = {
    quality: opts.lossless ? 100 : opts.quality, // ignored in pure lossless, but OK to pass
    lossless: !!opts.lossless,
    nearLossless: !!opts.nearLossless,
    alphaQuality: typeof opts.alphaQuality === 'number' ? opts.alphaQuality : undefined,
    effort: typeof opts.effort === 'number' ? opts.effort : undefined,
    smartSubsample: !!opts.smartSubsample
  };
  return pipeline.webp(webpOptions).toBuffer();
}

function parseBool(val, def = false) {
  if (val === undefined) return def;
  if (typeof val === 'boolean') return val;
  const s = String(val).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function clamp(num, min, max, def) {
  const n = Number(num);
  if (Number.isFinite(n)) return Math.min(max, Math.max(min, n));
  return def;
}

// Simple limited-concurrency mapper
async function mapWithLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      results[idx] = await mapper(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// -------- App setup --------
const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.static('public'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: MAX_FILES,
    fileSize: MAX_FILE_SIZE_MB * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    if (isImageMime(file.mimetype)) return cb(null, true);
    cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
  }
});

// -------- Routes --------
app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

/**
 * POST /convert
 * multipart/form-data with field "images" (single or multiple)
 * Query params:
 *  - output=auto|zip|multipart
 *  - quality=1..100 (default 80)
 *  - lossless=true|false
 *  - nearLossless=true|false
 *  - alphaQuality=0..100
 *  - effort=0..6 (compression effort)
 *  - smartSubsample=true|false
 */
app.post('/convert', upload.array('images', MAX_FILES), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files received. Use field name "images".' });
    }

    const files = req.files;

    const outputMode = String(req.query.output || 'auto').toLowerCase(); // auto | zip | multipart
    const quality = clamp(req.query.quality, 1, 100, DEFAULT_QUALITY);
    const lossless = parseBool(req.query.lossless, false);
    const nearLossless = parseBool(req.query.nearLossless, false);
    const alphaQuality = clamp(req.query.alphaQuality, 0, 100, undefined);
    const effort = clamp(req.query.effort, 0, 6, DEFAULT_EFFORT);
    const smartSubsample = parseBool(req.query.smartSubsample, false);

    const convertOpts = { quality, lossless, nearLossless, alphaQuality, effort, smartSubsample };

    // Decide response mode
    const wantsZip = outputMode === 'zip' || (outputMode === 'auto' && files.length > 1);
    const wantsMultipart = outputMode === 'multipart';

    // Single file → return a webp directly
    if (!wantsZip && !wantsMultipart && files.length === 1) {
      const file = files[0];
      const outName = changeExtToWebp(file.originalname || 'image.webp');
      const buf = await convertBufferToWebp(file.buffer, convertOpts);

      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Content-Disposition', `attachment; filename="${outName}"`);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(buf);
    }

    // Multiple files → either zip or multipart/mixed
    if (wantsZip) {
      const zipName = `converted_${Date.now()}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
      res.setHeader('Cache-Control', 'no-store');

      const archive = archiver('zip', { zlib: { level: 9 } });

      archive.on('error', (err) => {
        // stream-safe error handling
        if (!res.headersSent) res.status(500);
        res.end();
        console.error('Archiver error:', err);
      });

      archive.pipe(res);

      // Process with limited concurrency, append as buffers to keep API simple
      await mapWithLimit(files, CONVERT_CONCURRENCY, async (file) => {
        try {
          const outName = changeExtToWebp(file.originalname || 'image.webp');
          const buf = await convertBufferToWebp(file.buffer, convertOpts);
          archive.append(buf, { name: outName });
        } catch (err) {
          // Put a small error text file into the archive to indicate failure on this item
          const failName = `${sanitizeFilename(path.parse(file.originalname || 'image').name)}__ERROR.txt`;
          archive.append(String(err?.message || 'Conversion failed'), { name: failName });
        }
      });

      await archive.finalize();
      return; // stream response
    }

    // Multipart/mixed response (advanced clients)
    if (wantsMultipart) {
      const boundary = 'batch-' + crypto.randomUUID().replace(/-/g, '');
      res.setHeader('Content-Type', `multipart/mixed; boundary=${boundary}`);
      res.setHeader('Cache-Control', 'no-store');

      for (const file of files) {
        try {
          const outName = changeExtToWebp(file.originalname || 'image.webp');
          const buf = await convertBufferToWebp(file.buffer, convertOpts);

          res.write(`--${boundary}\r\n`);
          res.write(`Content-Type: image/webp\r\n`);
          res.write(`Content-Disposition: attachment; filename="${outName}"\r\n`);
          res.write(`Content-Length: ${buf.length}\r\n\r\n`);
          res.write(buf);
          res.write(`\r\n`);
        } catch (err) {
          const msg = String(err?.message || 'Conversion failed');
          const errName = `${sanitizeFilename(path.parse(file.originalname || 'image').name)}__ERROR.txt`;
          const errBuf = Buffer.from(msg, 'utf8');
          res.write(`--${boundary}\r\n`);
          res.write(`Content-Type: text/plain; charset=utf-8\r\n`);
          res.write(`Content-Disposition: attachment; filename="${errName}"\n`);
          res.write(`Content-Length: ${errBuf.length}\r\n\r\n`);
          res.write(errBuf);
          res.write(`\r\n`);
        }
      }
      res.end(`--${boundary}--\r\n`);
      return;
    }

    // Fallback (should not hit)
    return res.status(400).json({ error: 'Invalid output mode' });
  } catch (err) {
    next(err);
  }
});

// Global error handler
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const map = {
      LIMIT_FILE_SIZE: `File too large. Max ${MAX_FILE_SIZE_MB}MB per file.`,
      LIMIT_FILE_COUNT: `Too many files. Max ${MAX_FILES}.`,
      LIMIT_UNEXPECTED_FILE: 'Unsupported file. Only images are allowed.'
    };
    const message = map[err.code] || err.message;
    return res.status(400).json({ error: message, code: err.code });
  }
  console.error('Error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`✅ WebP Converter API running at http://localhost:${PORT}`);
  console.log(`   POST /convert (multipart/form-data, field "images")`);
});