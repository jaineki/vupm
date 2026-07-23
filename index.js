require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuration
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'videos';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024;
const MAX_VIDEO_SIZE = parseInt(process.env.MAX_VIDEO_SIZE) || 500 * 1024 * 1024;

let db;
let bucket;

// ============================================
// MONGODB CONNECTION - Optimized for Your String
// ============================================
async function connectToMongoDB() {
  try {
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI is not defined in environment variables');
    }

    console.log('🔄 Connecting to MongoDB Atlas...');
    console.log(`📁 Database: ${DB_NAME}`);
    console.log(`🔗 Using non-SRV connection string`);

    // Options optimized for your connection string
    const client = new MongoClient(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 30000,
      // SSL/TLS settings
      ssl: true,
      sslValidate: false, // Set to true in production with proper certificates
      tls: true,
      tlsAllowInvalidCertificates: true,
      tlsAllowInvalidHostnames: true,
      rejectUnauthorized: false,
      // Authentication
      authSource: 'admin',
      retryWrites: true,
      w: 'majority'
    });

    // Connect to MongoDB
    await client.connect();
    console.log('✅ MongoDB connected successfully');

    // Get the database
    db = client.db(DB_NAME);
    
    // Test the connection
    await db.command({ ping: 1 });
    console.log('✅ Database ping successful');

    // Create GridFS bucket
    bucket = new GridFSBucket(db, {
      bucketName: 'uploads'
    });

    // Create indexes
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
    console.error('\n🔧 Troubleshooting tips:');
    console.error('1. Check your password in .env file');
    console.error('2. Make sure your IP is whitelisted in MongoDB Atlas');
    console.error('3. Verify the database user has correct permissions');
    console.error('4. Check if your network allows MongoDB connections');
    console.error('\n📝 Your connection string format:');
    console.error('mongodb://username:password@host1:port,host2:port,host3:port/?ssl=true&replicaSet=...');
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

// ============================================
// MULTER CONFIGURATION
// ============================================
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    // Images
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    // Videos
    'video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo', 
    'video/x-matroska', 'video/webm', 'video/ogg', 'video/3gpp',
    // Audio
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/flac',
    // Documents
    'application/pdf', 'application/zip', 'application/x-zip-compressed',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // Text
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

// 1. General Upload
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
          database: DB_NAME
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

// 2. Video Upload
app.post('/upload/video.mp4', (req, res) => {
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
        tags: req.body.tags ? req.body.tags.split(',').map(t => t.trim()) : [],
        video: {
          codec: 'unknown',
          resolution: 'unknown',
          duration: 'unknown'
        }
      };

      const uploadStream = bucket.openUploadStream(uniqueFilename, {
        contentType: file.mimetype,
        metadata: metadata,
        chunkSizeBytes: 261120 // 255KB chunks for video streaming
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
          database: DB_NAME
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

// 3. Stream Video (with range support)
app.get('/stream/:id.mp4', async (req, res) => {
  try {
    const fileId = req.params.id;
    
    if (!ObjectId.isValid(fileId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid file ID format'
      });
    }

    const id = new ObjectId(fileId);
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

// 4. Get File
app.get('/file/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    
    if (!ObjectId.isValid(fileId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid file ID format'
      });
    }

    const id = new ObjectId(fileId);
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
      return res.redirect(`/stream/${fileId}`);
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

// 5. List Files
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

    const fileList = files.map(file => ({
      id: file._id.toString(),
      filename: file.metadata?.originalName || file.filename,
      contentType: file.contentType || 'application/octet-stream',
      fileSize: file.length,
      fileSizeFormatted: formatFileSize(file.length),
      uploadDate: file.uploadDate,
      uploadDateFormatted: new Date(file.uploadDate).toLocaleString(),
      url: `/file/${file._id.toString()}`,
      streamingUrl: file.contentType?.startsWith('video/') ? `/stream/${file._id.toString()}` : null,
      isVideo: file.contentType?.startsWith('video/') || false,
      isImage: file.contentType?.startsWith('image/') || false,
      metadata: file.metadata || {}
    }));

    res.json({
      success: true,
      files: fileList,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(totalFiles / limit),
        totalFiles: totalFiles,
        limit: limit
      },
      database: DB_NAME
    });

  } catch (error) {
    console.error('File listing error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving file list'
    });
  }
});

// 6. Delete File
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

// 7. Statistics
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
      },
      database: DB_NAME
    });

  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving statistics'
    });
  }
});

// 8. Health Check
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

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ============================================
// START SERVER
// ============================================
async function startServer() {
  await connectToMongoDB();
  
  app.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`📁 Serving static files from /public`);
    console.log(`🗄️  Database: ${DB_NAME}`);
    console.log(`🟢 Node.js version: ${process.version}`);
    console.log('\n📌 API Endpoints:');
    console.log(`   POST   /upload           - Upload any file`);
    console.log(`   POST   /upload/video     - Upload video file`);
    console.log(`   GET    /file/:id         - Get file`);
    console.log(`   GET    /stream/:id       - Stream video with range support`);
    console.log(`   GET    /files            - List all files`);
    console.log(`   GET    /stats            - Get statistics`);
    console.log(`   GET    /health           - Health check`);
    console.log(`   DELETE /file/:id         - Delete file`);
  });
}

startServer().catch(console.error);
