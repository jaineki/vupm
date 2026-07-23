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
// MINIMAL CORS - Allow everything
// ============================================
app.use(cors()); // Allow all origins
app.options('*', cors()); // Handle preflight

app.use(express.json({ limit: '500mb' })); // For base64 uploads
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(express.static('public'));

// Configuration
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'videos';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 500 * 1024 * 1024; // 500MB
const MAX_VIDEO_SIZE = parseInt(process.env.MAX_VIDEO_SIZE) || 1000 * 1024 * 1024; // 1GB

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
// MULTER CONFIGURATION (for POST uploads)
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

// 1. POST Upload (Standard)
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
        database: DB_NAME
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

// 2. GET Upload - Upload video using base64 in URL
app.get('/upload', async (req, res) => {
  try {
    const { url, filename, title } = req.query;
    
    if (!url) {
      return res.status(400).json({
        success: false,
        message: 'Missing url parameter. Usage: /upload?url=base64_encoded_video&filename=video.mp4'
      });
    }

    // Decode base64
    const videoBuffer = Buffer.from(url, 'base64');
    const originalName = filename || 'video.mp4';
    const uniqueFilename = generateUniqueFilename(originalName);
    const isVideo = true;
    
    const metadata = {
      originalName: originalName,
      uniqueName: uniqueFilename,
      uploadDate: new Date(),
      isVideo: isVideo,
      fileSize: videoBuffer.length,
      contentType: 'video/mp4',
      database: DB_NAME,
      title: title || originalName,
      uploadMethod: 'GET'
    };

    const uploadStream = bucket.openUploadStream(uniqueFilename, {
      contentType: 'video/mp4',
      metadata: metadata,
      chunkSizeBytes: 261120
    });

    uploadStream.write(videoBuffer);
    uploadStream.end();

    uploadStream.on('finish', () => {
      res.json({
        success: true,
        message: 'Video uploaded successfully via GET',
        fileId: uploadStream.id.toString(),
        filename: originalName,
        contentType: 'video/mp4',
        fileSize: videoBuffer.length,
        fileUrl: `/file/${uploadStream.id.toString()}`,
        streamingUrl: `/stream/${uploadStream.id.toString()}`,
        streamingUrlWithExtension: `/stream/${uploadStream.id.toString()}.mp4`
      });
    });

    uploadStream.on('error', (error) => {
      console.error('GridFS upload error:', error);
      res.status(500).json({
        success: false,
        message: 'Error uploading video to database'
      });
    });

  } catch (error) {
    console.error('GET upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Error processing video upload',
      error: error.message
    });
  }
});

// 3. POST Video Upload
app.post('/upload/video', (req, res) => {
  videoUpload(req, res, async (err) => {
    if (err) {
      console.error('Video upload error:', err);
      return res.status(400).json({
        success: false,
        message: err.message || 'Video upload failed'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No video file uploaded'
      });
    }

    try {
      const file = req.file;
      const uniqueFilename = generateUniqueFilename(file.originalname);
      
      const metadata = {
        originalName: file.originalname,
        uniqueName: uniqueFilename,
        uploadDate: new Date(),
        isVideo: true,
        fileSize: file.size,
        contentType: file.mimetype,
        database: DB_NAME,
        title: req.body.title || file.originalname,
        description: req.body.description || '',
        category: req.body.category || 'Uncategorized',
        tags: req.body.tags ? req.body.tags.split(',').map(t => t.trim()) : []
      };

      const uploadStream = bucket.openUploadStream(uniqueFilename, {
        contentType: file.mimetype,
        metadata: metadata,
        chunkSizeBytes: 261120
      });

      uploadStream.write(file.buffer);
      uploadStream.end();

      uploadStream.on('finish', () => {
        res.json({
          success: true,
          message: 'Video uploaded successfully',
          fileId: uploadStream.id.toString(),
          filename: file.originalname,
          contentType: file.mimetype,
          fileSize: file.size,
          title: metadata.title,
          description: metadata.description,
          category: metadata.category,
          tags: metadata.tags,
          fileUrl: `/file/${uploadStream.id.toString()}`,
          streamingUrl: `/stream/${uploadStream.id.toString()}`,
          streamingUrlWithExtension: `/stream/${uploadStream.id.toString()}.mp4`
        });
      });

      uploadStream.on('error', (error) => {
        console.error('GridFS upload error:', error);
        res.status(500).json({
          success: false,
          message: 'Error uploading video to database'
        });
      });

    } catch (error) {
      console.error('Video upload error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error during video upload'
      });
    }
  });
});

// 4. STREAM VIDEO - Supports .mp4 extensions
app.get('/stream/:id', async (req, res) => {
  try {
    let fileId = req.params.id;
    const cleanId = extractFileId(fileId);
    
    console.log(`🔍 Streaming: ${fileId} -> ${cleanId}`);
    
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

// 5. GET FILE - Supports .mp4 extensions
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

// 6. List Files
app.get('/files', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    const type = req.query.type;
    
    let filter = {};
    if (type === 'video') {
      filter = { 'contentType': { $regex: '^video/' } };
    } else if (type === 'image') {
      filter = { 'contentType': { $regex: '^image/' } };
    } else if (type === 'audio') {
      filter = { 'contentType': { $regex: '^audio/' } };
    } else if (type === 'document') {
      filter = { 'contentType': { $regex: '^(application/|text/)' } };
    }
    
    const totalFiles = await db.collection('uploads.files').countDocuments(filter);
    
    const files = await db.collection('uploads.files')
      .find(filter)
      .sort({ uploadDate: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const fileList = files.map(file => {
      const isVideo = file.contentType && file.contentType.startsWith('video/');
      const fileId = file._id.toString();
      
      return {
        id: fileId,
        filename: file.metadata?.originalName || file.filename,
        contentType: file.contentType || 'application/octet-stream',
        fileSize: file.length,
        fileSizeFormatted: formatFileSize(file.length),
        uploadDate: file.uploadDate,
        uploadDateFormatted: new Date(file.uploadDate).toLocaleString(),
        url: `/file/${fileId}`,
        urlWithExtension: isVideo ? `/file/${fileId}.mp4` : `/file/${fileId}`,
        streamingUrl: isVideo ? `/stream/${fileId}` : null,
        streamingUrlWithExtension: isVideo ? `/stream/${fileId}.mp4` : null,
        isVideo: isVideo,
        metadata: file.metadata || {}
      };
    });

    res.json({
      success: true,
      files: fileList,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalFiles / limit),
        totalFiles: totalFiles,
        limit: limit
      }
    });

  } catch (error) {
    console.error('File listing error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving file list'
    });
  }
});

// 7. Delete File
app.delete('/file/:id', async (req, res) => {
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
    console.error('File deletion error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting file'
    });
  }
});

// 8. Statistics
app.get('/stats', async (req, res) => {
  try {
    const totalFiles = await db.collection('uploads.files').countDocuments();
    const videoFiles = await db.collection('uploads.files').countDocuments({
      contentType: { $regex: '^video/' }
    });
    const imageFiles = await db.collection('uploads.files').countDocuments({
      contentType: { $regex: '^image/' }
    });
    const audioFiles = await db.collection('uploads.files').countDocuments({
      contentType: { $regex: '^audio/' }
    });
    
    const totalSizeResult = await db.collection('uploads.files').aggregate([
      { $group: { _id: null, total: { $sum: '$length' } } }
    ]).toArray();
    const totalSize = totalSizeResult.length > 0 ? totalSizeResult[0].total : 0;

    res.json({
      success: true,
      stats: {
        totalFiles: totalFiles,
        totalSize: totalSize,
        totalSizeFormatted: formatFileSize(totalSize),
        videoFiles: videoFiles,
        imageFiles: imageFiles,
        audioFiles: audioFiles,
        otherFiles: totalFiles - (videoFiles + imageFiles + audioFiles)
      }
    });

  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving statistics'
    });
  }
});

// 9. Health Check
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

// 10. Root Route
app.get('/', (req, res) => {
  res.json({
    name: 'File Upload API (Unrestricted)',
    version: '1.0.0',
    database: DB_NAME,
    endpoints: {
      'POST /upload': 'Upload any file (multipart/form-data)',
      'GET /upload': 'Upload video via base64 (url parameter)',
      'POST /upload/video': 'Upload video with metadata',
      'GET /stream/:id': 'Stream video (supports .mp4 extension)',
      'GET /file/:id': 'Download file (supports .mp4 extension)',
      'GET /files': 'List all files',
      'GET /stats': 'Get statistics',
      'DELETE /file/:id': 'Delete file',
      'GET /health': 'Health check'
    },
    example: {
      uploadVideo: '/upload?url=BASE64_VIDEO_DATA&filename=video.mp4',
      stream: '/stream/8fd2b990b2c7199da7bbb58b5cb3301c',
      streamWithExtension: '/stream/8fd2b990b2c7199da7bbb58b5cb3301c.mp4',
      download: '/file/8fd2b990b2c7199da7bbb58b5cb3301c'
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
    console.log(`🌐 CORS: All origins allowed (unrestricted)`);
    console.log('\n📌 API Endpoints:');
    console.log(`   POST   /upload           - Upload any file`);
    console.log(`   GET    /upload           - Upload video via base64`);
    console.log(`   POST   /upload/video     - Upload video with metadata`);
    console.log(`   GET    /stream/:id       - Stream video (supports .mp4)`);
    console.log(`   GET    /file/:id         - Get file (supports .mp4)`);
    console.log(`   GET    /files            - List all files`);
    console.log(`   GET    /stats            - Get statistics`);
    console.log(`   GET    /health           - Health check`);
    console.log(`   DELETE /file/:id         - Delete file`);
  });
}

startServer().catch(console.error);
