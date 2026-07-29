const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { MongoClient, ObjectId, GridFSBucket } = require('mongodb');
const multer = require('multer');
const crypto = require('crypto');
const axios = require("axios");
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
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
app.use(cors());
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
// AUTH CONFIGURATION (Account creation / sign in)
// ============================================
const JWT_SECRET = process.env.JWT_SECRET || "vupm_dev_secret_change_me_in_env";
const JWT_EXPIRES_IN = "30d";
if (!process.env.JWT_SECRET) {
  console.warn('⚠️ JWT_SECRET not set in environment. Using an insecure default — set JWT_SECRET in Render for production.');
}

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
      await db.collection('chat_messages').createIndex({ id: 1 }, { unique: true });

      // Account indexes
      await db.collection('chat_users').createIndex({ usernameLower: 1 }, { unique: true });
      await db.collection('chat_users').createIndex(
        { email: 1 },
        { unique: true, partialFilterExpression: { email: { $type: "string" } } }
      );

      // Video engagement indexes
      await db.collection('video_stats').createIndex({ fileId: 1 }, { unique: true });
      await db.collection('video_comments').createIndex({ fileId: 1, timestamp: 1 });
      
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
// ACCOUNT HELPERS (JWT-based auth)
// ============================================
function signToken(user) {
  return jwt.sign(
    { userId: user._id.toString(), username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function sanitizeUser(user) {
  return {
    id: user._id.toString(),
    username: user.username,
    email: user.email || null,
    createdAt: user.createdAt
  };
}

// Verifies a JWT sent in the Authorization: Bearer <token> header
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ success: false, message: "Access token required" });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ success: false, message: "Invalid or expired session. Please sign in again." });
    }
    req.userId = decoded.userId;
    req.username = decoded.username;
    next();
  });
};

// Like authenticateToken, but does not block the request if the token is
// missing or invalid — used for endpoints that work for guests too but add
// extra info (e.g. "did I already like this") when signed in.
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return next();

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (!err && decoded) {
      req.userId = decoded.userId;
      req.username = decoded.username;
    }
    next();
  });
};

// ============================================
// ACCOUNT API ROUTES (Create account / Sign in / Sign out)
// ============================================
app.post('/api/auth/register', async (req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.status(503).json({ success: false, message: "Database not connected. Try again shortly." });
    }

    const { username, email, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Username and password are required" });
    }

    const cleanUsername = username.trim().slice(0, MAX_USERNAME_LENGTH);
    if (cleanUsername.length < 3) {
      return res.status(400).json({ success: false, message: "Username must be at least 3 characters" });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    }

    const usernameLower = cleanUsername.toLowerCase();
    const cleanEmail = email ? String(email).trim().toLowerCase() : null;

    const existingUsername = await db.collection('chat_users').findOne({ usernameLower });
    if (existingUsername) {
      return res.status(409).json({ success: false, message: "That username is already taken" });
    }

    if (cleanEmail) {
      const existingEmail = await db.collection('chat_users').findOne({ email: cleanEmail });
      if (existingEmail) {
        return res.status(409).json({ success: false, message: "That email is already registered" });
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const nowIso = new Date().toISOString();

    const newUser = {
      username: cleanUsername,
      usernameLower,
      email: cleanEmail,
      passwordHash,
      createdAt: nowIso,
      lastLoginAt: nowIso
    };

    const result = await db.collection('chat_users').insertOne(newUser);
    newUser._id = result.insertedId;

    const token = signToken(newUser);

    res.json({ success: true, message: "Account created successfully", token, user: sanitizeUser(newUser) });

  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, message: "Registration failed: " + error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.status(503).json({ success: false, message: "Database not connected. Try again shortly." });
    }

    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Username/email and password are required" });
    }

    const identifier = username.trim().toLowerCase();
    const user = await db.collection('chat_users').findOne({
      $or: [{ usernameLower: identifier }, { email: identifier }]
    });

    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid username or password" });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ success: false, message: "Invalid username or password" });
    }

    await db.collection('chat_users').updateOne(
      { _id: user._id },
      { $set: { lastLoginAt: new Date().toISOString() } }
    );

    const token = signToken(user);

    res.json({ success: true, message: "Signed in successfully", token, user: sanitizeUser(user) });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: "Sign in failed: " + error.message });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.status(503).json({ success: false, message: "Database not connected" });
    }

    const user = await db.collection('chat_users').findOne({ _id: new ObjectId(req.userId) });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({ success: true, user: sanitizeUser(user) });

  } catch (error) {
    console.error('Auth check error:', error);
    res.status(500).json({ success: false, message: "Error verifying session: " + error.message });
  }
});

// Stateless JWT logout — client discards the token. Endpoint kept for a clean sign-out flow / logging.
app.post('/api/auth/logout', authenticateToken, (req, res) => {
  res.json({ success: true, message: "Signed out successfully" });
});

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

  if (isMongoConnected()) {
    db.collection('chat_messages').deleteOne({ id: messageId }).catch(err =>
      console.error('DB delete message error:', err)
    );
  }
  
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

  if (isMongoConnected()) {
    db.collection('chat_messages').deleteMany({}).catch(err =>
      console.error('DB delete all messages error:', err)
    );
  }
  
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

  if (isMongoConnected()) {
    db.collection('chat_messages').deleteMany({ userId }).catch(err =>
      console.error('DB delete user messages error:', err)
    );
  }
  
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

  if (isMongoConnected()) {
    db.collection('chat_messages').deleteMany({ timestamp: { $lt: cutoffTime.toISOString() } }).catch(err =>
      console.error('DB delete old messages error:', err)
    );
  }
  
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
// VIDEO ENGAGEMENT ROUTES (views / likes / comments)
// All tied to signed-in accounts and stored in MongoDB
// ============================================

// GET stats for a video: views, like/dislike counts, and whether the
// current signed-in user has already liked/disliked it.
app.get('/api/videos/:id/stats', optionalAuth, async (req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.json({ success: true, views: 0, likeCount: 0, dislikeCount: 0, userLiked: false, userDisliked: false });
    }

    const fileId = req.params.id;
    const stats = await db.collection('video_stats').findOne({ fileId });

    const likedBy = (stats && stats.likedBy) || [];
    const dislikedBy = (stats && stats.dislikedBy) || [];

    res.json({
      success: true,
      views: (stats && stats.views) || 0,
      likeCount: likedBy.length,
      dislikeCount: dislikedBy.length,
      userLiked: !!(req.userId && likedBy.includes(req.userId)),
      userDisliked: !!(req.userId && dislikedBy.includes(req.userId))
    });
  } catch (error) {
    console.error('Video stats error:', error);
    res.status(500).json({ success: false, message: "Error loading video stats: " + error.message });
  }
});

// Register a view — counts once per signed-in account per video
app.post('/api/videos/:id/view', authenticateToken, async (req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.status(503).json({ success: false, message: "Database not connected" });
    }

    const fileId = req.params.id;
    const existing = await db.collection('video_stats').findOne({ fileId, viewedBy: req.userId });

    if (!existing) {
      await db.collection('video_stats').updateOne(
        { fileId },
        {
          $inc: { views: 1 },
          $addToSet: { viewedBy: req.userId },
          $setOnInsert: { likedBy: [], dislikedBy: [] }
        },
        { upsert: true }
      );
    }

    const stats = await db.collection('video_stats').findOne({ fileId });
    res.json({ success: true, views: (stats && stats.views) || 0 });

  } catch (error) {
    console.error('View tracking error:', error);
    res.status(500).json({ success: false, message: "Error recording view: " + error.message });
  }
});

// Toggle like (removes an existing dislike from the same account)
app.post('/api/videos/:id/like', authenticateToken, async (req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.status(503).json({ success: false, message: "Database not connected" });
    }

    const fileId = req.params.id;
    const userId = req.userId;

    let stats = await db.collection('video_stats').findOne({ fileId });
    const alreadyLiked = stats && stats.likedBy && stats.likedBy.includes(userId);

    if (alreadyLiked) {
      await db.collection('video_stats').updateOne(
        { fileId },
        { $pull: { likedBy: userId } }
      );
    } else {
      await db.collection('video_stats').updateOne(
        { fileId },
        {
          $addToSet: { likedBy: userId },
          $pull: { dislikedBy: userId },
          $setOnInsert: { views: 0 }
        },
        { upsert: true }
      );
    }

    stats = await db.collection('video_stats').findOne({ fileId });
    const likedBy = (stats && stats.likedBy) || [];
    const dislikedBy = (stats && stats.dislikedBy) || [];

    res.json({
      success: true,
      likeCount: likedBy.length,
      dislikeCount: dislikedBy.length,
      userLiked: likedBy.includes(userId),
      userDisliked: dislikedBy.includes(userId)
    });

  } catch (error) {
    console.error('Like error:', error);
    res.status(500).json({ success: false, message: "Error updating like: " + error.message });
  }
});

// Toggle dislike (removes an existing like from the same account)
app.post('/api/videos/:id/dislike', authenticateToken, async (req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.status(503).json({ success: false, message: "Database not connected" });
    }

    const fileId = req.params.id;
    const userId = req.userId;

    let stats = await db.collection('video_stats').findOne({ fileId });
    const alreadyDisliked = stats && stats.dislikedBy && stats.dislikedBy.includes(userId);

    if (alreadyDisliked) {
      await db.collection('video_stats').updateOne(
        { fileId },
        { $pull: { dislikedBy: userId } }
      );
    } else {
      await db.collection('video_stats').updateOne(
        { fileId },
        {
          $addToSet: { dislikedBy: userId },
          $pull: { likedBy: userId },
          $setOnInsert: { views: 0 }
        },
        { upsert: true }
      );
    }

    stats = await db.collection('video_stats').findOne({ fileId });
    const likedBy = (stats && stats.likedBy) || [];
    const dislikedBy = (stats && stats.dislikedBy) || [];

    res.json({
      success: true,
      likeCount: likedBy.length,
      dislikeCount: dislikedBy.length,
      userLiked: likedBy.includes(userId),
      userDisliked: dislikedBy.includes(userId)
    });

  } catch (error) {
    console.error('Dislike error:', error);
    res.status(500).json({ success: false, message: "Error updating dislike: " + error.message });
  }
});

// List comments for a video (newest last)
app.get('/api/videos/:id/comments', async (req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.json({ success: true, comments: [] });
    }

    const fileId = req.params.id;
    const comments = await db.collection('video_comments')
      .find({ fileId })
      .sort({ timestamp: 1 })
      .toArray();

    res.json({
      success: true,
      comments: comments.map(c => ({
        id: c._id.toString(),
        userId: c.userId,
        username: c.username,
        text: c.text,
        timestamp: c.timestamp
      }))
    });

  } catch (error) {
    console.error('Load comments error:', error);
    res.status(500).json({ success: false, message: "Error loading comments: " + error.message });
  }
});

// Post a comment — requires a signed-in account
app.post('/api/videos/:id/comments', authenticateToken, async (req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.status(503).json({ success: false, message: "Database not connected" });
    }

    const fileId = req.params.id;
    const text = (req.body && req.body.text || '').trim().slice(0, 1000);

    if (!text) {
      return res.status(400).json({ success: false, message: "Comment cannot be empty" });
    }

    const comment = {
      fileId,
      userId: req.userId,
      username: req.username,
      text,
      timestamp: new Date().toISOString()
    };

    const result = await db.collection('video_comments').insertOne(comment);

    res.json({
      success: true,
      comment: {
        id: result.insertedId.toString(),
        userId: comment.userId,
        username: comment.username,
        text: comment.text,
        timestamp: comment.timestamp
      }
    });

  } catch (error) {
    console.error('Post comment error:', error);
    res.status(500).json({ success: false, message: "Error posting comment: " + error.message });
  }
});

// Delete a comment — only the comment's author (or an admin) can delete it
app.delete('/api/videos/:id/comments/:commentId', authenticateToken, async (req, res) => {
  try {
    if (!isMongoConnected()) {
      return res.status(503).json({ success: false, message: "Database not connected" });
    }

    const { commentId } = req.params;
    const comment = await db.collection('video_comments').findOne({ _id: new ObjectId(commentId) });

    if (!comment) {
      return res.status(404).json({ success: false, message: "Comment not found" });
    }

    if (comment.userId !== req.userId) {
      return res.status(403).json({ success: false, message: "You can only delete your own comments" });
    }

    await db.collection('video_comments').deleteOne({ _id: new ObjectId(commentId) });
    res.json({ success: true, message: "Comment deleted" });

  } catch (error) {
    console.error('Delete comment error:', error);
    res.status(500).json({ success: false, message: "Error deleting comment: " + error.message });
  }
});

// ============================================
// SOCKET.IO LOGIC (with AI Integration)
// ============================================
io.on("connection", async (socket) => {
  console.log(`New client connected: ${socket.id}`);

  // Send existing messages to new user (loaded from MongoDB so it survives refreshes/redeploys)
  try {
    if (isMongoConnected()) {
      const dbMessages = await db.collection('chat_messages')
        .find({})
        .sort({ timestamp: -1 })
        .limit(50)
        .toArray();

      const ordered = dbMessages.reverse().map(m => ({
        id: m.id,
        userId: m.userId,
        username: m.username,
        message: m.message,
        timestamp: m.timestamp
      }));

      socket.emit("messages:history", ordered);
    } else {
      socket.emit("messages:history", messages.slice(-50));
    }
  } catch (historyError) {
    console.error('History load error:', historyError);
    socket.emit("messages:history", messages.slice(-50));
  }

  // User joins — requires a valid account (JWT from sign in / account creation)
  socket.on("user:join", async (data) => {
    const { token } = data || {};

    if (!token) {
      socket.emit("error", { message: "You must sign in to join the chat" });
      return;
    }

    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      socket.emit("error", { message: "Your session has expired. Please sign in again." });
      return;
    }

    const userId = decoded.userId;
    let trimmedUsername = decoded.username;

    // Pull the freshest username from the account record, in case it changed
    try {
      if (isMongoConnected()) {
        const accountUser = await db.collection('chat_users').findOne({ _id: new ObjectId(userId) });
        if (!accountUser) {
          socket.emit("error", { message: "Account not found. Please sign in again." });
          return;
        }
        trimmedUsername = accountUser.username;
      }
    } catch (lookupErr) {
      console.error('User lookup error:', lookupErr);
    }

    // If this account is already connected on another socket, drop the old connection
    const existingEntry = users.get(userId);
    if (existingEntry && existingEntry.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(existingEntry.socketId);
      if (oldSocket) {
        oldSocket.emit("error", { message: "You signed in from another device/tab." });
        oldSocket.disconnect(true);
      }
    }

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

    if (isMongoConnected()) {
      db.collection('chat_messages').insertOne(messageObj).catch(err =>
        console.error('Save message error:', err)
      );
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

        if (isMongoConnected()) {
          db.collection('chat_messages').insertOne(aiMessage).catch(err =>
            console.error('Save AI message error:', err)
          );
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

        if (isMongoConnected()) {
          db.collection('chat_messages').insertOne(errorMessage).catch(err =>
            console.error('Save AI error message error:', err)
          );
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
