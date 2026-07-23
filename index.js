require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuration
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'file_upload_db';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024; // 10MB default

// MongoDB connection
let db;
let bucket;

async function connectToMongoDB() {
  try {
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI is not defined in environment variables');
    }
    
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
    bucket = new GridFSBucket(db, {
      bucketName: 'uploads'
    });
    
    console.log('Connected to MongoDB successfully');
    console.log(`Database: ${DB_NAME}`);
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

// Multer configuration (memory storage for validation)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: MAX_FILE_SIZE
  },
  fileFilter: (req, file, cb) => {
    // Basic file type validation
    const allowedMimeTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      'video/mp4', 'video/mpeg', 'video/quicktime',
      'audio/mpeg', 'audio/wav', 'audio/ogg',
      'application/pdf',
      'application/zip', 'application/x-zip-compressed',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain'
    ];
    
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} is not supported`));
    }
  }
}).single('file');

// Routes

// Upload endpoint
app.post('/upload', (req, res) => {
  upload(req, res, async (err) => {
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
      
      // Upload to GridFS
      const uploadStream = bucket.openUploadStream(file.originalname, {
        contentType: file.mimetype,
        metadata: {
          originalName: file.originalname,
          uploadDate: new Date()
        }
      });

      // Write file buffer to GridFS
      uploadStream.write(file.buffer);
      uploadStream.end();

      uploadStream.on('finish', () => {
        const fileId = uploadStream.id;
        
        res.json({
          success: true,
          message: 'File uploaded successfully',
          fileId: fileId.toString(),
          filename: file.originalname,
          contentType: file.mimetype,
          fileSize: file.size
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

// Get file by ID (for viewing/downloading)
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
    
    // Set appropriate headers
    res.set({
      'Content-Type': file.contentType || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${file.filename}"`,
      'Content-Length': file.length
    });

    // Stream the file
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

// Get all files list
app.get('/files', async (req, res) => {
  try {
    const files = await db.collection('uploads.files')
      .find({})
      .sort({ uploadDate: -1 })
      .toArray();

    const fileList = files.map(file => ({
      id: file._id.toString(),
      filename: file.filename,
      contentType: file.contentType || 'application/octet-stream',
      fileSize: file.length,
      uploadDate: file.uploadDate,
      url: `/file/${file._id.toString()}`
    }));

    res.json({
      success: true,
      files: fileList
    });

  } catch (error) {
    console.error('File listing error:', error);
    res.status(500).json({
      success: false,
      message: 'Error retrieving file list'
    });
  }
});

// Delete file by ID
app.delete('/file/:id', async (req, res) => {
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
    
    // Check if file exists
    const files = await db.collection('uploads.files').find({ _id: id }).toArray();
    if (files.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

    // Delete the file
    await bucket.delete(id);

    res.json({
      success: true,
      message: 'File deleted successfully'
    });

  } catch (error) {
    console.error('File deletion error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting file'
    });
  }
});

// Start server
async function startServer() {
  await connectToMongoDB();
  
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Max file size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
  });
}

// Start the application
startServer().catch(console.error);
