require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuration
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'file_upload_db';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024; // 100MB default
const MAX_VIDEO_SIZE = parseInt(process.env.MAX_VIDEO_SIZE) || 500 * 1024 * 1024; // 500MB for videos

// MongoDB connection
let db;
let bucket;

async function connectToMongoDB() {
  try {
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI is not defined in environment variables');
    }
    
    const client = new MongoClient(MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    
    await client.connect();
    db = client.db(DB_NAME);
    bucket = new GridFSBucket(db, {
      bucketName: 'uploads'
    });
    
    // Create indexes for better performance
    await db.collection('uploads.files').createIndex({ filename: 1 });
    await db.collection('uploads.files').createIndex({ uploadDate: -1 });
    await db.collection('uploads.files').createIndex({ 'metadata.video': 1 });
    
    console.log('✅ Connected to MongoDB successfully');
    console.log(`📁 Database: ${DB_NAME}`);
    console.log(`📊 Max file size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    console.log(`🎬 Max video size: ${MAX_VIDEO_SIZE / (1024 * 1024)}MB`);
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
}

// Multer configuration for general files
const storage = multer.memoryStorage();

// File filter for general uploads
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    // Images
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp',
    // Videos
    'video/mp4', 'video/mpeg', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
    'video/webm', 'video/ogg', 'video/3gpp', 'video/3gpp2', 'video/x-flv',
    // Audio
    'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/flac',
    'audio/webm', 'audio/mp4',
    // Documents
    'application/pdf',
    'application/zip', 'application/x-zip-compressed', 'application/x-rar-compressed',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/rtf',
    // Text
    'text/plain', 'text/csv', 'text/html', 'text/css', 'text/javascript',
    // Other
    'application/json', 'application/xml'
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

// Special upload for videos with larger size limit
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

// Helper function to generate unique filename
function generateUniqueFilename(originalName) {
  const timestamp = Date.now();
  const randomStr = crypto.randomBytes(8).toString('hex');
  const extension = path.extname(originalName);
  const nameWithoutExt = path.basename(originalName, extension);
  return `${nameWithoutExt}_${timestamp}_${randomStr}${extension}`;
}

// Helper function to get file extension
function getFileExtension(filename) {
  return path.extname(filename).toLowerCase().slice(1);
}

// ============================================
// API ENDPOINTS
// ============================================

// 1. GENERAL UPLOAD API - Accepts all file types
app.post('/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(400).json({
        success: false,
        message: err.message || 'File upload failed',
        error: err.message
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded. Please select a file.'
      });
    }

    try {
      const file = req.file;
      const uniqueFilename = generateUniqueFilename(file.originalname);
      const fileExtension = getFileExtension(file.originalname);
      const isVideo = file.mimetype.startsWith('video/');
      
      // Prepare metadata
      const metadata = {
        originalName: file.originalname,
        uniqueName: uniqueFilename,
        uploadDate: new Date(),
        fileExtension: fileExtension,
        isVideo: isVideo,
        uploadType: 'general'
      };

      // If it's a video, extract additional info (if possible)
      if (isVideo) {
        metadata.video = {
          codec: 'unknown',
          resolution: 'unknown',
          duration: 'unknown'
        };
      }

      // Upload to GridFS
      const uploadStream = bucket.openUploadStream(uniqueFilename, {
        contentType: file.mimetype,
        metadata: metadata
      });

      // Write file buffer to GridFS
      uploadStream.write(file.buffer);
      uploadStream.end();

      const result = await new Promise((resolve, reject) => {
        uploadStream.on('finish', () => {
          resolve({
            fileId: uploadStream.id,
            filename: uniqueFilename,
            originalName: file.originalname,
            contentType: file.mimetype,
            fileSize: file.size,
            metadata: metadata
          });
        });

        uploadStream.on('error', (error) => {
          reject(error);
        });
      });

      res.json({
        success: true,
        message: 'File uploaded successfully',
        fileId: result.fileId.toString(),
        filename: result.originalName,
        contentType: result.contentType,
        fileSize: result.fileSize,
        uniqueFilename: result.filename,
        uploadDate: result.metadata.uploadDate,
        isVideo: isVideo,
        fileUrl: `/file/${result.fileId.toString()}`
      });

    } catch (error) {
      console.error('Upload error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error during upload',
        error: error.message
      });
    }
  });
});

// 2. DEDICATED VIDEO UPLOAD API - Optimized for videos
app.post('/upload/video', (req, res) => {
  videoUpload(req, res, async (err) => {
    if (err) {
      console.error('Video upload error:', err);
      return res.status(400).json({
        success: false,
        message: err.message || 'Video upload failed',
        error: err.message
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No video file uploaded. Please select a video file.'
      });
    }

    try {
      const file = req.file;
      const uniqueFilename = generateUniqueFilename(file.originalname);
      const fileExtension = getFileExtension(file.originalname);
      
      // Video-specific metadata
      const metadata = {
        originalName: file.originalname,
        uniqueName: uniqueFilename,
        uploadDate: new Date(),
        fileExtension: fileExtension,
        isVideo: true,
        uploadType: 'video',
        video: {
          codec: 'unknown',
          resolution: 'unknown',
          duration: 'unknown',
          bitrate: 'unknown',
          frameRate: 'unknown'
        },
        // Additional video info from request body
        title: req.body.title || file.originalname,
        description: req.body.description || '',
        category: req.body.category || 'Uncategorized',
        tags: req.body.tags ? req.body.tags.split(',').map(t => t.trim()) : []
      };

      // Upload to GridFS
      const uploadStream = bucket.openUploadStream(uniqueFilename, {
        contentType: file.mimetype,
        metadata: metadata,
        chunkSizeBytes: 261120 // 255KB chunks for better streaming
      });

      // Write file buffer to GridFS
      uploadStream.write(file.buffer);
      uploadStream.end();

      const result = await new Promise((resolve, reject) => {
        uploadStream.on('finish', () => {
          resolve({
            fileId: uploadStream.id,
            filename: uniqueFilename,
            originalName: file.originalname,
            contentType: file.mimetype,
            fileSize: file.size,
            metadata: metadata
          });
        });

        uploadStream.on('error', (error) => {
          reject(error);
        });
      });

      res.json({
        success: true,
        message: 'Video uploaded successfully',
        fileId: result.fileId.toString(),
        filename: result.originalName,
        contentType: result.contentType,
        fileSize: result.fileSize,
        uniqueFilename: result.filename,
        uploadDate: result.metadata.uploadDate,
        title: result.metadata.title,
        description: result.metadata.description,
        category: result.metadata.category,
        tags: result.metadata.tags,
        fileUrl: `/file/${result.fileId.toString()}`,
        // For video streaming
        streamingUrl: `/stream/${result.fileId.toString()}`
      });

    } catch (error) {
      console.error('Video upload error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error during video upload',
        error: error.message
      });
    }
  });
});

// 3. STREAMING API - For video streaming with range support
app.get('/stream/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    
    // Validate ObjectId
    if (!ObjectId.isValid(fileId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid file ID format'
      });
    }

    const id = new ObjectId(fileId);
    
    // Find file in GridFS
    const files = await db.collection('uploads.files').find({ _id: id }).toArray();
    
    if (files.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    const file = files[0];
    
    // Check if it's a video
    const isVideo = file.contentType && file.contentType.startsWith('video/');
    
    if (!isVideo) {
      return res.status(400).json({
        success: false,
        message: 'This endpoint only supports video files'
      });
    }

    const fileSize = file.length;
    const range = req.headers.range;
    
    // Handle range requests (for video seeking)
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
      // Full file request
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

// 4. GET FILE BY ID - Supports video playback and downloads
app.get('/file/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    
    // Validate ObjectId
    if (!ObjectId.isValid(fileId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid file ID format'
      });
    }

    const id = new ObjectId(fileId);
    
    // Find file in GridFS
    const files = await db.collection('uploads.files').find({ _id: id }).toArray();
    
    if (files.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    const file = files[0];
    const isVideo = file.contentType && file.contentType.startsWith('video/');
    
    // For videos, use the streaming endpoint for better performance
    if (isVideo && req.query.stream !== 'false') {
      // Redirect to streaming endpoint with range support
      return res.redirect(`/stream/${fileId}`);
    }
    
    // For non-videos or direct download
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

// 5. GET ALL FILES LIST
app.get('/files', async (req, res) => {
  try {
    // Pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;
    
    // Filter by type
    const type = req.query.type; // 'video', 'image', 'audio', 'document', 'other'
    
    let filter = {};
    if (type) {
      switch(type) {
        case 'video':
          filter = { 'contentType': { $regex: '^video/' } };
          break;
        case 'image':
          filter = { 'contentType': { $regex: '^image/' } };
          break;
        case 'audio':
          filter = { 'contentType': { $regex: '^audio/' } };
          break;
        case 'document':
          filter = { 'contentType': { $regex: '^(application/|text/)' } };
          break;
        default:
          break;
      }
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
      const isImage = file.contentType && file.contentType.startsWith('image/');
      
      return {
        id: file._id.toString(),
        filename: file.metadata?.originalName || file.filename,
        uniqueFilename: file.filename,
        contentType: file.contentType || 'application/octet-stream',
        fileSize: file.length,
        uploadDate: file.uploadDate,
        uploadDateFormatted: new Date(file.uploadDate).toLocaleString(),
        url: `/file/${file._id.toString()}`,
        streamingUrl: isVideo ? `/stream/${file._id.toString()}` : null,
        isVideo: isVideo,
        isImage: isImage,
        metadata: file.metadata || {},
        downloadUrl: `/file/${file._id.toString()}?stream=false`
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

// 6. GET FILE METADATA ONLY
app.get('/file/:id/metadata', async (req, res) => {
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
    
    res.json({
      success: true,
      file: {
        id: file._id.toString(),
        filename: file.metadata?.originalName || file.filename,
        contentType: file.contentType,
        fileSize: file.length,
        uploadDate: file.uploadDate,
        isVideo: isVideo,
        metadata: file.metadata || {},
        url: `/file/${file._id.toString()}`,
        streamingUrl: isVideo ? `/stream/${file._id.toString()}` : null
      }
    });

  } catch (error) {
    console.error('Metadata retrieval error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving file metadata'
    });
  }
});

// 7. DELETE FILE
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
    
    // Delete the file
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

// 8. BULK DELETE FILES
app.delete('/files', async (req, res) => {
  try {
    const { fileIds } = req.body;
    
    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide an array of file IDs to delete'
      });
    }
    
    const validIds = fileIds.filter(id => ObjectId.isValid(id));
    const objectIds = validIds.map(id => new ObjectId(id));
    
    if (objectIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid file IDs provided'
      });
    }
    
    // Delete each file
    const results = [];
    for (const id of objectIds) {
      try {
        await bucket.delete(id);
        results.push({
          id: id.toString(),
          success: true
        });
      } catch (error) {
        results.push({
          id: id.toString(),
          success: false,
          error: error.message
        });
      }
    }
    
    res.json({
      success: true,
      message: `Deleted ${results.filter(r => r.success).length} files successfully`,
      results: results
    });

  } catch (error) {
    console.error('Bulk delete error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting files'
    });
  }
});

// 9. SEARCH FILES
app.get('/files/search', async (req, res) => {
  try {
    const query = req.query.q || '';
    const type = req.query.type;
    
    let filter = {
      $or: [
        { 'metadata.originalName': { $regex: query, $options: 'i' } },
        { filename: { $regex: query, $options: 'i' } },
        { 'metadata.title': { $regex: query, $options: 'i' } },
        { 'metadata.tags': { $regex: query, $options: 'i' } }
      ]
    };
    
    if (type) {
      switch(type) {
        case 'video':
          filter['contentType'] = { $regex: '^video/' };
          break;
        case 'image':
          filter['contentType'] = { $regex: '^image/' };
          break;
        case 'audio':
          filter['contentType'] = { $regex: '^audio/' };
          break;
        case 'document':
          filter['contentType'] = { $regex: '^(application/|text/)' };
          break;
        default:
          break;
      }
    }
    
    const files = await db.collection('uploads.files')
      .find(filter)
      .sort({ uploadDate: -1 })
      .limit(100)
      .toArray();
    
    const fileList = files.map(file => ({
      id: file._id.toString(),
      filename: file.metadata?.originalName || file.filename,
      contentType: file.contentType,
      fileSize: file.length,
      uploadDate: file.uploadDate,
      url: `/file/${file._id.toString()}`
    }));
    
    res.json({
      success: true,
      files: fileList,
      count: fileList.length
    });

  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      success: false,
      message: 'Error searching files'
    });
  }
});

// 10. GET FILE STATISTICS
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
    const documentFiles = await db.collection('uploads.files').countDocuments({
      contentType: { $regex: '^(application/|text/)' }
    });
    
    // Get total size
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
        documentFiles: documentFiles,
        otherFiles: totalFiles - (videoFiles + imageFiles + audioFiles + documentFiles)
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

// Helper function to format file size
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage()
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

// Start server
async function startServer() {
  await connectToMongoDB();
  
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📁 Serving static files from /public`);
    console.log('\n📌 API Endpoints:');
    console.log(`   POST   /upload           - Upload any file`);
    console.log(`   POST   /upload/video     - Upload video file`);
    console.log(`   GET    /file/:id         - Get file`);
    console.log(`   GET    /stream/:id       - Stream video with range support`);
    console.log(`   GET    /files            - List all files`);
    console.log(`   GET    /files/search     - Search files`);
    console.log(`   DELETE /file/:id         - Delete file`);
    console.log(`   DELETE /files            - Bulk delete files`);
    console.log(`   GET    /stats            - Get statistics`);
    console.log(`   GET    /health           - Health check`);
  });
}

// Start the application
startServer().catch(console.error);
