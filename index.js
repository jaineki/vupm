require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors());
app.options('*', cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(express.static('public'));

// ============================================
// CONFIGURATION
// ============================================
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'videos';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 500 * 1024 * 1024;
const MAX_VIDEO_SIZE = parseInt(process.env.MAX_VIDEO_SIZE) || 1000 * 1024 * 1024;

let db;
let bucket;

// ============================================
// MONGODB CONNECTION
// ============================================
async function connectToMongoDB() {
  try {
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI is not defined in environment variables');
    }

    console.log('🔄 Connecting to MongoDB Atlas...');
    console.log(`📁 Database: ${DB_NAME}`);

    const client = new MongoClient(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 30000,
      ssl: true,
      sslValidate: false,
      tls: true,
      tlsAllowInvalidCertificates: true,
      tlsAllowInvalidHostnames: true,
      rejectUnauthorized: false,
      authSource: 'admin',
      retryWrites: true,
      w: 'majority'
    });

    await client.connect();
    console.log('✅ MongoDB connected successfully');

    db = client.db(DB_NAME);
    
    await db.command({ ping: 1 });
    console.log('✅ Database ping successful');

    bucket = new GridFSBucket(db, {
      bucketName: 'uploads'
    });

    try {
      await db.collection('uploads.files').createIndex({ filename: 1 });
      await db.collection('uploads.files').createIndex({ uploadDate: -1 });
      await db.collection('uploads.files').createIndex({ 'metadata.originalName': 1 });
      console.log('✅ Indexes created successfully');
    } catch (indexError) {
      console.warn('⚠️ Index creation warning:', indexError.message);
    }

    console.log(`📊 Max file size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    console.log(`🎬 Max video size: ${MAX_VIDEO_SIZE / (1024 * 1024)}MB`);

    return client;

  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================
function generateUniqueFilename(originalName) {
  const timestamp = Date.now();
  const randomStr = crypto.randomBytes(8).toString('hex');
  const extension = path.extname(originalName);
  const nameWithoutExt = path.basename(originalName, extension);
  return `${nameWithoutExt}_${timestamp}_${randomStr}${extension}`;
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function extractFileId(idWithExtension) {
  const videoExtensions = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.mpeg', '.3gp', '.flv'];
  let cleanId = idWithExtension;
  for (const ext of videoExtensions) {
    if (cleanId.endsWith(ext)) {
      cleanId = cleanId.slice(0, -ext.length);
      break;
    }
  }
  return cleanId;
}

// ============================================
// MULTER CONFIGURATION
// ============================================
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo', 
    'video/x-matroska', 'video/webm', 'video/ogg', 'video/3gpp',
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/flac',
    'application/pdf', 'application/zip', 'application/x-zip-compressed',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'text/csv', 'text/html'
  ];
  
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${file.mimetype} is not supported`), false);
  }
};

const upload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE
  },
  fileFilter: fileFilter
});

const videoUpload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_VIDEO_SIZE
  },
  fileFilter: (req, file, cb) => {
    const videoMimeTypes = [
      'video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo',
      'video/x-matroska', 'video/webm', 'video/ogg', 'video/3gpp',
      'video/3gpp2', 'video/x-flv', 'video/avi', 'video/mkv'
    ];
    
    if (videoMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed for this endpoint'), false);
    }
  }
}).single('video');

// ============================================
// API ENDPOINTS
// ============================================

// 1. GET ALL FILES
app.get('/files', async (req, res) => {
  try {
    const files = await db.collection('uploads.files')
      .find({})
      .sort({ uploadDate: -1 })
      .toArray();

    const fileList = files.map(file => ({
      id: file._id.toString(),
      filename: file.metadata?.originalName || file.filename,
      uniqueFilename: file.filename,
      contentType: file.contentType || 'application/octet-stream',
      fileSize: file.length,
      fileSizeFormatted: formatFileSize(file.length),
      uploadDate: file.uploadDate,
      uploadDateFormatted: new Date(file.uploadDate).toLocaleString(),
      url: `/file/${file._id.toString()}`,
      streamingUrl: file.contentType?.startsWith('video/') ? `/stream/${file._id.toString()}` : null,
      isVideo: file.contentType?.startsWith('video/') || false,
      metadata: file.metadata || {}
    }));

    res.json({
      success: true,
      files: fileList,
      total: fileList.length
    });

  } catch (error) {
    console.error('File listing error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving file list'
    });
  }
});

// 2. UPLOAD FILE
app.post('/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({
        success: false,
        message: err.message || 'File upload failed'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    try {
      const file = req.file;
      const uniqueFilename = generateUniqueFilename(file.originalname);
      const isVideo = file.mimetype.startsWith('video/');
      
      const metadata = {
        originalName: file.originalname,
        uniqueName: uniqueFilename,
        uploadDate: new Date(),
        isVideo: isVideo,
        fileSize: file.size,
        contentType: file.mimetype,
        database: DB_NAME,
        title: req.body.title || file.originalname
      };

      const uploadStream = bucket.openUploadStream(uniqueFilename, {
        contentType: file.mimetype,
        metadata: metadata
      });

      uploadStream.write(file.buffer);
      uploadStream.end();

      uploadStream.on('finish', () => {
        res.json({
          success: true,
          message: 'File uploaded successfully',
          fileId: uploadStream.id.toString(),
          filename: file.originalname,
          contentType: file.mimetype,
          fileSize: file.size,
          fileUrl: `/file/${uploadStream.id.toString()}`,
          streamingUrl: isVideo ? `/stream/${uploadStream.id.toString()}` : null
        });
      });

      uploadStream.on('error', (error) => {
        console.error('GridFS upload error:', error);
        res.status(500).json({
          success: false,
          message: 'Error uploading file to database'
        });
      });

    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error during upload'
      });
    }
  });
});

// 3. STREAM VIDEO
app.get('/stream/:id', async (req, res) => {
  try {
    let fileId = req.params.id;
    const cleanId = extractFileId(fileId);
    
    if (!ObjectId.isValid(cleanId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid file ID format'
      });
    }

    const id = new ObjectId(cleanId);
    const files = await db.collection('uploads.files').find({ _id: id }).toArray();
    
    if (files.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    const file = files[0];
    
    if (!file.contentType || !file.contentType.startsWith('video/')) {
      return res.status(400).json({
        success: false,
        message: 'This endpoint only supports video files'
      });
    }

    const fileSize = file.length;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': file.contentType,
        'Cache-Control': 'public, max-age=31557600'
      });
      
      const downloadStream = bucket.openDownloadStream(id, {
        start: start,
        end: end + 1
      });
      
      downloadStream.pipe(res);
      
      downloadStream.on('error', (error) => {
        console.error('Stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Error streaming video'
          });
        }
      });
      
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': file.contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31557600'
      });
      
      const downloadStream = bucket.openDownloadStream(id);
      downloadStream.pipe(res);
      
      downloadStream.on('error', (error) => {
        console.error('Stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            message: 'Error streaming video'
          });
        }
      });
    }

  } catch (error) {
    console.error('Stream error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// 4. GET FILE
app.get('/file/:id', async (req, res) => {
  try {
    let fileId = req.params.id;
    const cleanId = extractFileId(fileId);
    
    if (!ObjectId.isValid(cleanId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid file ID format'
      });
    }

    const id = new ObjectId(cleanId);
    const files = await db.collection('uploads.files').find({ _id: id }).toArray();
    
    if (files.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    const file = files[0];
    const isVideo = file.contentType && file.contentType.startsWith('video/');
    
    if (isVideo && req.query.stream !== 'false') {
      return res.redirect(`/stream/${cleanId}`);
    }

    res.set({
      'Content-Type': file.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${file.metadata?.originalName || file.filename}"`,
      'Content-Length': file.length,
      'Cache-Control': 'public, max-age=31557600'
    });

    const downloadStream = bucket.openDownloadStream(id);
    downloadStream.pipe(res);

    downloadStream.on('error', (error) => {
      console.error('Download error:', error);
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          message: 'Error streaming file'
        });
      }
    });

  } catch (error) {
    console.error('File retrieval error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

// 5. RENAME FILE (PATCH)
app.patch('/file/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    const { filename } = req.body;

    if (!filename || !filename.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Filename is required'
      });
    }

    if (!ObjectId.isValid(fileId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid file ID format'
      });
    }

    const id = new ObjectId(fileId);
    
    // Check if file exists
    const files = await db.collection('uploads.files').find({ _id: id }).toArray();
    if (files.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    // Update the filename in metadata
    const result = await db.collection('uploads.files').updateOne(
      { _id: id },
      { 
        $set: { 
          'metadata.originalName': filename.trim(),
          'metadata.lastModified': new Date()
        } 
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(500).json({
        success: false,
        message: 'Failed to rename file'
      });
    }

    res.json({
      success: true,
      message: 'File renamed successfully',
      fileId: fileId,
      newFilename: filename.trim()
    });

  } catch (error) {
    console.error('Rename error:', error);
    res.status(500).json({
      success: false,
      message: 'Error renaming file: ' + error.message
    });
  }
});

// 6. DELETE FILE
app.delete('/file/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    
    if (!ObjectId.isValid(fileId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid file ID format'
      });
    }

    const id = new ObjectId(fileId);
    
    // Check if file exists
    const files = await db.collection('uploads.files').find({ _id: id }).toArray();
    if (files.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    const file = files[0];
    
    // Delete the file from GridFS
    await bucket.delete(id);

    res.json({
      success: true,
      message: 'File deleted successfully',
      deletedFile: {
        id: file._id.toString(),
        filename: file.metadata?.originalName || file.filename
      }
    });

  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting file: ' + error.message
    });
  }
});

// 7. HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: DB_NAME,
    connected: !!db,
    nodeVersion: process.version
  });
});

// 8. ROOT
app.get('/', (req, res) => {
  res.json({
    name: 'Jay Video Hub API',
    version: '2.0.0',
    database: DB_NAME,
    endpoints: {
      'GET /files': 'List all files',
      'POST /upload': 'Upload a file',
      'GET /file/:id': 'Download a file',
      'GET /stream/:id': 'Stream a video',
      'PATCH /file/:id': 'Rename a file',
      'DELETE /file/:id': 'Delete a file',
      'GET /health': 'Health check'
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

// ============================================
// START SERVER
// ============================================
async function startServer() {
  await connectToMongoDB();
  
  app.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`📁 Database: ${DB_NAME}`);
    console.log(`🌐 CORS: All origins allowed`);
    console.log('\n📌 API Endpoints:');
    console.log(`   GET    /files           - List all files`);
    console.log(`   POST   /upload          - Upload a file`);
    console.log(`   GET    /file/:id        - Download a file`);
    console.log(`   GET    /stream/:id      - Stream a video`);
    console.log(`   PATCH  /file/:id        - Rename a file`);
    console.log(`   DELETE /file/:id        - Delete a file`);
    console.log(`   GET    /health          - Health check`);
  });
}

startServer().catch(console.error);
