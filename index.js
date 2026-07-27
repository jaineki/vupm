const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const multer = require('multer');
const crypto = require('crypto');
const axios = require("axios");
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// ============================================
// SOCKET.IO CONFIGURATION
// ============================================
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

// ============================================
// MIDDLEWARE
// ============================================
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(express.static("public"));

// ============================================
// CHAT CONFIGURATION (In-memory storage)
// ============================================
const users = new Map();
let messages = [];
const MAX_MESSAGE_LENGTH = 500;
const MAX_USERNAME_LENGTH = 30;
const MAX_MESSAGES_STORED = 1000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// ============================================
// FILE UPLOAD CONFIGURATION
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
      console.warn('⚠️ MONGODB_URI not set. File upload features will not work.');
      return null;
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

    // Create indexes
    try {
      await db.collection('uploads.files').createIndex({ filename: 1 });
      await db.collection('uploads.files').createIndex({ uploadDate: -1 });
      await db.collection('uploads.files').createIndex({ 'metadata.originalName': 1 });
      
      // Create chat collections if they don't exist
      const collections = await db.listCollections().toArray();
      const collectionNames = collections.map(c => c.name);
      
      if (!collectionNames.includes('chat_messages')) {
        await db.createCollection('chat_messages');
        console.log('✅ Created chat_messages collection');
      }
      
      if (!collectionNames.includes('chat_users')) {
        await db.createCollection('chat_users');
        console.log('✅ Created chat_users collection');
      }
      
      await db.collection('chat_messages').createIndex({ timestamp: -1 });
      await db.collection('chat_messages').createIndex({ userId: 1 });
      
      console.log('✅ Indexes created successfully');
    } catch (indexError) {
      console.warn('⚠️ Index creation warning:', indexError.message);
    }

    console.log(`📊 Max file size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    console.log(`🎬 Max video size: ${MAX_VIDEO_SIZE / (1024 * 1024)}MB`);

    return client;

  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    console.warn('⚠️ Continuing without MongoDB. File upload features will not work.');
    return null;
  }
}

// ============================================
// HELPER FUNCTIONS (Chat)
// ============================================
const getOnlineUsers = () => {
  return Array.from(users.values()).map(user => ({
    userId: user.userId,
    username: user.username
  }));
};

const broadcastUsers = () => {
  const onlineUsers = getOnlineUsers();
  io.emit("users:update", onlineUsers);
};

// ============================================
// HELPER FUNCTIONS (File Upload)
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

// ============================================
// ADMIN AUTHENTICATION MIDDLEWARE
// ============================================
const authenticateAdmin = (req, res, next) => {
  const providedPassword = req.headers['x-admin-password'] || req.query.adminPassword;
  
  if (!providedPassword) {
    return res.status(401).json({
      success: false,
      message: "Admin password required"
    });
  }

  if (providedPassword === ADMIN_PASSWORD) {
    next();
  } else {
    res.status(403).json({
      success: false,
      message: "Invalid admin password"
    });
  }
};

// User authentication middleware for deleting their own messages
const authenticateUser = (req, res, next) => {
  const userId = req.headers['x-user-id'];
  const messageId = req.params.id;
  
  if (!userId) {
    return res.status(401).json({
      success: false,
      message: "User ID required"
    });
  }
  
  const message = messages.find(m => m.id === messageId);
  if (!message) {
    return res.status(404).json({
      success: false,
      message: "Message not found"
    });
  }
  
  if (message.userId !== userId) {
    return res.status(403).json({
      success: false,
      message: "You can only delete your own messages"
    });
  }
  
  if (!users.has(userId)) {
    return res.status(401).json({
      success: false,
      message: "User not found or disconnected"
    });
  }
  
  next();
};

// ============================================
// CHAT API ROUTES
// ============================================
app.get("/api", (req, res) => {
  res.json({
    success: true,
    message: "Real-time chat API is running",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/users", (req, res) => {
  res.json({
    success: true,
    users: getOnlineUsers(),
    count: users.size
  });
});

app.get("/api/info", (req, res) => {
  res.json({
    success: true,
    api: "Real-time Chat API",
    version: "1.0.0",
    socketIO: true,
    availableEvents: [
      "user:join",
      "user:leave",
      "users:update",
      "message:send",
      "message:new",
      "typing:start",
      "typing:stop"
    ],
    onlineUsers: users.size,
    totalMessages: messages.length,
    maxMessagesStored: MAX_MESSAGES_STORED
  });
});

app.get("/api/messages", (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const recentMessages = messages.slice(-limit);
  
  res.json({
    success: true,
    count: recentMessages.length,
    total: messages.length,
    messages: recentMessages
  });
});

app.get("/api/messages/:id", (req, res) => {
  const message = messages.find(m => m.id === req.params.id);
  
  if (!message) {
    return res.status(404).json({
      success: false,
      message: "Message not found"
    });
  }
  
  res.json({
    success: true,
    message
  });
});

app.delete("/api/messages/:id", authenticateUser, (req, res) => {
  const messageId = req.params.id;
  const userId = req.headers['x-user-id'];
  
  const messageIndex = messages.findIndex(m => m.id === messageId);
  
  if (messageIndex === -1) {
    return res.status(404).json({
      success: false,
      message: "Message not found"
    });
  }
  
  const deletedMessage = messages[messageIndex];
  messages.splice(messageIndex, 1);
  
  io.emit("message:deleted", {
    messageId: messageId,
    userId: userId,
    deletedBy: "user",
    timestamp: new Date().toISOString()
  });
  
  res.json({
    success: true,
    message: "Message deleted successfully",
    deletedMessage
  });
});

app.delete("/api/messages/all", authenticateAdmin, (req, res) => {
  const deletedCount = messages.length;
  messages = [];
  
  io.emit("messages:cleared", {
    deletedCount,
    clearedBy: "admin",
    timestamp: new Date().toISOString()
  });
  
  res.json({
    success: true,
    message: "All messages deleted successfully",
    deletedCount
  });
});

app.delete("/api/messages/user/:userId", authenticateAdmin, (req, res) => {
  const userId = req.params.userId;
  const userMessages = messages.filter(m => m.userId === userId);
  const deletedCount = userMessages.length;
  
  messages = messages.filter(m => m.userId !== userId);
  
  io.emit("messages:cleared", {
    deletedCount,
    userId,
    clearedBy: "admin",
    timestamp: new Date().toISOString()
  });
  
  res.json({
    success: true,
    message: `Deleted ${deletedCount} messages from user`,
    deletedCount,
    userId
  });
});

app.delete("/api/messages/old/:hours", authenticateAdmin, (req, res) => {
  const hours = parseInt(req.params.hours);
  if (isNaN(hours) || hours <= 0) {
    return res.status(400).json({
      success: false,
      message: "Invalid hours parameter"
    });
  }
  
  const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
  const deletedMessages = messages.filter(m => new Date(m.timestamp) < cutoffTime);
  const deletedCount = deletedMessages.length;
  
  messages = messages.filter(m => new Date(m.timestamp) >= cutoffTime);
  
  io.emit("messages:cleared", {
    deletedCount,
    olderThanHours: hours,
    clearedBy: "admin",
    timestamp: new Date().toISOString()
  });
  
  res.json({
    success: true,
    message: `Deleted ${deletedCount} messages older than ${hours} hours`,
    deletedCount,
    hours
  });
});

// ============================================
// FILE UPLOAD API ROUTES
// ============================================
// Check if MongoDB is connected
const isMongoConnected = () => db && bucket;

// GET ALL FILES
app.get('/files', async (req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.json({
        success: true,
        files: [],
        total: 0,
        message: 'MongoDB not connected. Please check your connection string.'
      });
    }

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
      message: 'Error retrieving file list: ' + error.message,
      files: [],
      total: 0
    });
  }
});

// UPLOAD FILE
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
      if (!isMongoConnected()) {
        return res.status(503).json({
          success: false,
          message: 'MongoDB not connected. Please check your connection.'
        });
      }

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

// STREAM VIDEO
app.get('/stream/:id', async (req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.status(503).json({
        success: false,
        message: 'MongoDB not connected'
      });
    }

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

// GET FILE
app.get('/file/:id', async (req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.status(503).json({
        success: false,
        message: 'MongoDB not connected'
      });
    }

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

// RENAME FILE (PATCH)
app.patch('/file/:id', async (req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.status(503).json({
        success: false,
        message: 'MongoDB not connected'
      });
    }

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
    
    const files = await db.collection('uploads.files').find({ _id: id }).toArray();
    if (files.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }

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

// DELETE FILE
app.delete('/file/:id', async (req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.status(503).json({
        success: false,
        message: 'MongoDB not connected'
      });
    }

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
    console.error('Delete error:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting file: ' + error.message
    });
  }
});

// ============================================
// SOCKET.IO LOGIC (with AI Integration)
// ============================================
io.on("connection", (socket) => {
  console.log(`New client connected: ${socket.id}`);

  // Send existing messages to new user
  const recentMessages = messages.slice(-50);
  socket.emit("messages:history", recentMessages);

  // User joins
  socket.on("user:join", (data) => {
    const { username } = data;
    
    if (!username || username.trim().length === 0) {
      socket.emit("error", { message: "Username is required" });
      return;
    }
    
    const trimmedUsername = username.trim().slice(0, MAX_USERNAME_LENGTH);
    
    const existingUser = Array.from(users.values()).find(
      user => user.username.toLowerCase() === trimmedUsername.toLowerCase()
    );
    
    if (existingUser) {
      socket.emit("error", { message: "Username already taken" });
      return;
    }
    
    const userId = uuidv4();
    
    users.set(userId, {
      userId,
      socketId: socket.id,
      username: trimmedUsername,
      joinedAt: new Date().toISOString()
    });
    
    socket.join(`user:${userId}`);
    
    socket.emit("user:joined", {
      userId,
      username: trimmedUsername,
      joinedAt: new Date().toISOString()
    });
    
    socket.emit("users:update", getOnlineUsers());
    
    socket.broadcast.emit("user:join", {
      userId,
      username: trimmedUsername,
      joinedAt: new Date().toISOString()
    });
    
    broadcastUsers();
    
    console.log(`User ${trimmedUsername} (${userId}) joined`);
  });

  // ============================================
  // SEND MESSAGE WITH AI SUPPORT (UPDATED API)
  // ============================================
  socket.on("message:send", async (data) => {
    const { message } = data;

    const user = Array.from(users.values()).find(
      u => u.socketId === socket.id
    );

    if (!user) {
      socket.emit("error", { message: "You must join the chat first" });
      return;
    }

    if (!message || message.trim().length === 0) {
      socket.emit("error", { message: "Message cannot be empty" });
      return;
    }

    const trimmedMessage = message.trim().slice(0, MAX_MESSAGE_LENGTH);

    // Save the user's message
    const messageObj = {
      id: uuidv4(),
      userId: user.userId,
      username: user.username,
      message: trimmedMessage,
      timestamp: new Date().toISOString()
    };

    messages.push(messageObj);
    if (messages.length > MAX_MESSAGES_STORED) {
      messages = messages.slice(-MAX_MESSAGES_STORED);
    }

    io.emit("message:new", messageObj);

    // ============================================
    // AI COMMAND HANDLER (UPDATED API)
    // ============================================
    if (trimmedMessage.toLowerCase().startsWith("/ai ")) {

      const prompt = trimmedMessage.substring(4).trim();

      if (!prompt) {
        const errorMsg = {
          id: uuidv4(),
          userId: "ai-bot",
          username: "🤖 AI",
          message: "⚠️ Please ask a question. Example: `/ai who is David?`",
          timestamp: new Date().toISOString()
        };
        messages.push(errorMsg);
        io.emit("message:new", errorMsg);
        return;
      }

      // Send typing indicator for AI
      io.emit("typing:start", {
        userId: "ai-bot",
        username: "🤖 AI"
      });

      try {
        // Call the updated AI API
        const response = await axios.get(
          "https://selovapi.onrender.com/api/jay",
          {
            params: {
              prompt: prompt,
              uid: "8" // You can change this to a dynamic user ID
            },
            timeout: 15000 // 15 second timeout
          }
        );

        // Extract the AI response
        let aiReply = "Sorry, I couldn't understand that.";

        if (response.data) {
          if (response.data.response) {
            aiReply = response.data.response;
          } else if (response.data.answer) {
            aiReply = response.data.answer;
          } else if (response.data.message) {
            aiReply = response.data.message;
          } else if (response.data.result) {
            aiReply = response.data.result;
          } else if (typeof response.data === 'string') {
            aiReply = response.data;
          } else {
            aiReply = JSON.stringify(response.data);
          }
        }

        // Create AI message
        const aiMessage = {
          id: uuidv4(),
          userId: "ai-bot",
          username: "🤖 AI",
          message: aiReply.substring(0, 2000), // Limit message length
          timestamp: new Date().toISOString()
        };

        messages.push(aiMessage);
        if (messages.length > MAX_MESSAGES_STORED) {
          messages = messages.slice(-MAX_MESSAGES_STORED);
        }

        io.emit("message:new", aiMessage);

      } catch (err) {
        console.error('AI Error:', err.message);

        // Send error message
        const errorMessage = {
          id: uuidv4(),
          userId: "ai-bot",
          username: "🤖 AI",
          message: "⚠️ Sorry, I couldn't reach the AI service. Please try again later.",
          timestamp: new Date().toISOString()
        };

        messages.push(errorMessage);
        if (messages.length > MAX_MESSAGES_STORED) {
          messages = messages.slice(-MAX_MESSAGES_STORED);
        }

        io.emit("message:new", errorMessage);
      } finally {
        // Stop typing indicator
        io.emit("typing:stop", {
          userId: "ai-bot",
          username: "🤖 AI"
        });
      }
    }

    console.log(`Message from ${user.username}: ${trimmedMessage}`);
  });

  // Typing indicators
  socket.on("typing:start", () => {
    const user = Array.from(users.values()).find(
      u => u.socketId === socket.id
    );
    
    if (user) {
      socket.broadcast.emit("typing:start", {
        userId: user.userId,
        username: user.username
      });
    }
  });

  socket.on("typing:stop", () => {
    const user = Array.from(users.values()).find(
      u => u.socketId === socket.id
    );
    
    if (user) {
      socket.broadcast.emit("typing:stop", {
        userId: user.userId,
        username: user.username
      });
    }
  });

  // User disconnect
  socket.on("disconnect", (reason) => {
    console.log(`Client ${socket.id} disconnected: ${reason}`);
    
    let disconnectedUser = null;
    
    for (const [userId, user] of users.entries()) {
      if (user.socketId === socket.id) {
        disconnectedUser = user;
        users.delete(userId);
        break;
      }
    }
    
    if (disconnectedUser) {
      io.emit("user:leave", {
        userId: disconnectedUser.userId,
        username: disconnectedUser.username,
        leftAt: new Date().toISOString()
      });
      
      broadcastUsers();
      
      console.log(`User ${disconnectedUser.username} (${disconnectedUser.userId}) disconnected`);
    }
  });

  socket.on("error", (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });
});

// ============================================
// ERROR HANDLING
// ============================================
server.on("error", (error) => {
  console.error("Server error:", error);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down server...");
  io.close(() => {
    server.close(() => {
      console.log("Server closed");
      process.exit(0);
    });
  });
});

// ============================================
// START SERVER
// ============================================
async function startServer() {
  await connectToMongoDB();
  
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`\n🚀 Server running on port ${PORT}`);
    console.log(`📁 Database: ${DB_NAME || 'videos'}`);
    console.log(`🔑 Admin password: ${ADMIN_PASSWORD}`);
    console.log(`🤖 AI Bot: Enabled (/ai command)`);
    console.log(`🌐 AI API: https://selovapi.onrender.com/api/jay`);
    console.log('\n📌 Pages:');
    console.log(`   🏠 Main Player: http://localhost:${PORT}/`);
    console.log(`   💬 Chat: http://localhost:${PORT}/chat.html`);
    console.log(`   🛠️ Admin: http://localhost:${PORT}/admin.html`);
    console.log(`   📁 File Manager: http://localhost:${PORT}/rename.html`);
    console.log('\n📌 API Endpoints:');
    console.log(`   🗣️ Chat API: /api/messages`);
    console.log(`   📁 File API: /files`);
    console.log(`   📤 Upload: /upload`);
    console.log(`   🎬 Stream: /stream/:id`);
    console.log(`\n🤖 AI Commands:`);
    console.log(`   /ai [question] - Ask AI anything`);
    console.log(`   Example: /ai who is David?`);
  });
}

startServer().catch(console.error);
