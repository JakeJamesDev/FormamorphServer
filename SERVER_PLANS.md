# Exotic Dangerous World Workshop Server

A Node.js server for hosting user-created worlds for Exotic Dangerous, providing a "Steam Workshop"-like experience.

## Overview

This server allows users to:
1. Create accounts and authenticate
2. Upload their world creations
3. Browse, search, and download worlds created by others
4. Edit or delete their own worlds

## Architecture

The server is built as a single project that includes both the API server and database components, allowing for simple one-command installation and startup.

### Technology Stack

- **Backend**: Node.js with Express.js
- **Database**: MongoDB (using Mongoose ODM)
- **Authentication**: JWT (JSON Web Tokens)

### Database Schema

#### Users Collection
- `_id`: MongoDB ObjectId
- `username`: String (unique)
- `password`: String (hashed)
- `email`: String (optional)
- `createdAt`: Date
- `updatedAt`: Date

#### Worlds Collection
- `_id`: MongoDB ObjectId
- `name`: String
- `description`: String
- `author`: ObjectId (reference to Users)
- `thumbnail`: String (base64 encoded image)
- `previewData`: Object (JSON for preview information, includes thumbnail, name, description)
- `contentData`: Object (JSON for world content, includes worldOverview, stats, locations, entities, traits, statUpdates)
- `createdAt`: Date
- `updatedAt`: Date
- `downloads`: Number
- `tags`: Array of Strings (optional)

The world data structure follows the format defined in `WorldFormat.md`, with the following key components:

```javascript
// Example world data structure
{
  id: "unique-world-id",
  worldOverview: {
    name: "World Name",
    description: "World description",
    author: "Author name",
    thumbnail: "base64-encoded-image",
    bgm: "base64-encoded-audio",
    systemPrompt: "AI context for the world",
    use3DModel: true
  },
  stats: [...],      // Array of stat objects
  locations: [...],  // Array of location objects
  entities: [...],   // Array of entity objects
  traits: [...],     // Array of trait objects
  statUpdates: [...] // Array of stat update rules
}
```
However, this world data structure may change in future updates so don't do validation checks on them, just keep in mind to store it as a large json object

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Login and get JWT token
- `POST /api/auth/change-password` - Change password

### World Management
- `GET /api/worlds` - List worlds with filtering options
- `GET /api/worlds/:id` - Get world details
- `GET /api/worlds/:id/content` - Download world content
- `POST /api/worlds` - Create/upload a new world
- `PUT /api/worlds/:id` - Update world metadata or content
- `DELETE /api/worlds/:id` - Delete a world (owner only)

### User Management
- `GET /api/users/:id/worlds` - Get worlds created by a specific user
- `GET /api/users/me` - Get current user profile

## Installation & Setup

### Prerequisites
- Node.js (v14 or higher)
- npm or yarn

### One-Line Installation
```bash
npm install && npm start
```

This command will:
1. Install all dependencies
2. Set up the embedded MongoDB instance
3. Start the server

### Environment Variables
Create a `.env` file in the root directory with the following variables:

```
PORT=3001
MONGODB_URI=mongodb://localhost:27017/exotic-dangerous
JWT_SECRET=your_jwt_secret_key
JWT_EXPIRE=24h
```

### Sample package.json
```json
{
  "name": "exotic-dangerous-server",
  "version": "1.0.0",
  "description": "Server for hosting Exotic Dangerous worlds",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.0.3",
    "express": "^4.18.2",
    "express-validator": "^7.0.1",
    "jsonwebtoken": "^9.0.0",
    "mongoose": "^7.0.3",
    "morgan": "^1.10.0"
  },
  "devDependencies": {
    "nodemon": "^2.0.22"
  }
}
```

## Project Structure

```
server/
├── config/                 # Configuration files
│   ├── db.js               # Database connection
│   └── default.json        # Default configuration
├── models/                 # Mongoose models
│   ├── User.js             # User model
│   └── World.js            # World model
├── routes/                 # API routes
│   ├── auth.js             # Authentication routes
│   ├── users.js            # User routes
│   └── worlds.js           # World routes
├── controllers/            # Route controllers
│   ├── authController.js   # Authentication logic
│   ├── userController.js   # User management logic
│   └── worldController.js  # World management logic
├── middleware/             # Custom middleware
│   ├── auth.js             # Authentication middleware
│   └── error.js            # Error handling middleware
├── utils/                  # Utility functions
├── app.js                  # Express application setup
├── server.js               # Server entry point
└── package.json            # Project dependencies
```

## Key Files to Understand World Format

To understand the world data format, refer to these files in the main project:

1. `WorldFormat.md` - Detailed documentation of the world data structure
2. `services/WorldStorageService.js` - Current implementation of world storage in the browser
3. `views/MainMenu.jsx` - UI for world selection and management
4. `defaultworlds/*.json` - Example world data files

## Integration with Client

The server is designed to work with the existing client with minimal modifications:

1. Extend `WorldStorageService.js` to communicate with the server:

```javascript
// Add to WorldStorageService.js
const API_URL = 'http://localhost:3001/api';
let authToken = localStorage.getItem('authToken');

// Authentication methods
async function login(username, password) {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await response.json();
  if (response.ok) {
    authToken = data.token;
    localStorage.setItem('authToken', authToken);
    return true;
  }
  return false;
}

// World fetching methods
async function fetchRemoteWorlds() {
  const response = await fetch(`${API_URL}/worlds`, {
    headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
  });
  return await response.json();
}

async function uploadWorld(worldData) {
  if (!authToken) return false;
  
  const response = await fetch(`${API_URL}/worlds`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`
    },
    body: JSON.stringify({
      name: worldData.worldOverview.name,
      description: worldData.worldOverview.description,
      thumbnail: worldData.worldOverview.thumbnail,
      previewData: {
        name: worldData.worldOverview.name,
        description: worldData.worldOverview.description,
        thumbnail: worldData.worldOverview.thumbnail
      },
      contentData: worldData
    })
  });
  return response.ok;
}
```

2. Add authentication UI components (login/register forms)
3. Modify `MainMenu.jsx` to display remote worlds alongside local worlds

## Security Considerations

1. All passwords are hashed using bcrypt
2. JWT tokens are used for authentication
3. Users can only modify their own worlds
4. Input validation is implemented for all API endpoints
5. Rate limiting prevents API abuse

## Future Enhancements (Not Implemented in Minimal Version)

1. User roles and moderation features
2. Social features (comments, ratings)
3. Analytics for tracking popular worlds
4. Storage quotas per user
5. Advanced search and filtering options
