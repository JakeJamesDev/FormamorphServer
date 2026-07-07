# Exotic Dangerous World Workshop Server

A Node.js server for hosting user-created worlds for Exotic Dangerous, providing a "Steam Workshop"-like experience.

## Overview

This server allows users to:
1. Create accounts and authenticate
2. Upload their world creations
3. Browse, search, and download worlds created by others
4. Edit or delete their own worlds

Admin users have additional capabilities:
1. Manage user accounts (view all users, update user status and account type)
2. Edit or delete any world, not just their own

## Key Features

- **SQLite Database**: Reliable and corruption-resistant database solution
- **File-based Storage**: World content (20MB+ JSON files) stored as separate files
- **Separate Thumbnail Storage**: Thumbnails stored as image files rather than base64 in the database
- **JWT Authentication**: Secure user authentication with JSON Web Tokens
- **Role-based Access Control**: Different permissions for normal users and admins
- **Search & Filtering**: Search worlds by name, description, tags, or author

## Installation & Setup

### Prerequisites
- Node.js (v14 or higher)
- npm or yarn

### Installation

1. Clone the repository
2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
   - Create a `.env` file in the root directory with the following variables (or use the existing one):
   ```
   PORT=8797
   JWT_SECRET=your_jwt_secret_key_change_this_in_production
   JWT_EXPIRE=24h
   NODE_ENV=development
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=admin123
   ADMIN_EMAIL=admin@example.com
   ```

4. Initialize the database:
```bash
npm run init-db
```

5. Start the server:
```bash
npm start
```

For development with auto-restart:
```bash
npm run dev
```

## Project Structure

```
server/
├── src/                   # Source code
│   ├── config/            # Configuration files
│   │   └── db.js          # Database connection
│   ├── controllers/       # Route controllers
│   │   ├── authController.js  # Authentication logic
│   │   ├── userController.js  # User management logic
│   │   └── worldController.js # World management logic
│   ├── middleware/        # Custom middleware
│   │   ├── auth.js        # Authentication middleware
│   │   └── error.js       # Error handling middleware
│   ├── models/            # Data models
│   │   ├── User.js        # User model
│   │   └── World.js       # World model
│   ├── routes/            # API routes
│   │   ├── auth.js        # Authentication routes
│   │   ├── users.js       # User routes
│   │   └── worlds.js      # World routes
│   ├── utils/             # Utility functions
│   │   ├── fileStorage.js # File storage utilities
│   │   ├── generateToken.js # JWT token generation
│   │   └── initDb.js      # Database initialization
│   ├── storage/           # File storage
│   │   ├── worlds/        # World content JSON files
│   │   └── thumbnails/    # Thumbnail image files
│   ├── app.js             # Express application setup
│   └── server.js          # Server entry point
├── data/                  # SQLite database file
├── package.json           # Project dependencies
└── .env                   # Environment variables
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Login and get JWT token
- `POST /api/auth/change-password` - Change password
- `GET /api/auth/me` - Get current user profile

### World Management
- `GET /api/worlds` - List worlds with filtering and sorting options
- `GET /api/worlds/:id` - Get world details
- `GET /api/worlds/:id/content` - Download world content
- `POST /api/worlds` - Create/upload a new world
- `PUT /api/worlds/:id` - Update world metadata or content
- `PUT /api/worlds/:id/spoiler` - Set world spoiler status (world owner or admin only)
- `DELETE /api/worlds/:id` - Delete a world

#### World Listing and Sorting
The `GET /api/worlds` endpoint supports the following query parameters:

- `page` - Page number for pagination (default: 1)
- `limit` - Number of worlds per page (default: 10)
- `search` - Search term for filtering worlds by name, description, or tags
- `tags` - Comma-separated list of tags to filter by
- `searchByAuthor` - Set to 'true' to search by author username instead of world properties
- `sort` - Field to sort by (options: 'created_at', 'updated_at', 'downloads', 'name')
- `order` - Sort direction ('asc' or 'desc', default: 'desc')

Example requests:
```
GET /api/worlds?sort=downloads&order=desc  # Sort by most downloaded
GET /api/worlds?sort=updated_at&order=desc  # Sort by most recently updated
GET /api/worlds?sort=name&order=asc  # Sort alphabetically by name
```

### Comment Management
- `GET /api/worlds/:worldId/comments` - Get all comments for a world
- `POST /api/worlds/:worldId/comments` - Create a new comment for a world
- `GET /api/comments/:id` - Get a single comment
- `PUT /api/comments/:id` - Update a comment (comment author or admin only)
- `DELETE /api/comments/:id` - Delete a comment (comment author, world owner, or admin only)

### Thumbnails
- `GET /api/thumbnails/:filename` - Get thumbnail image by filename

### User Management
- `GET /api/users/:id/worlds` - Get worlds created by a specific user
- `GET /api/users/me` - Get current user profile
- `GET /api/users/me/worlds` - Get worlds created by the current user
- `GET /api/users` - Get all users (admin only)
- `PUT /api/users/:id/status` - Update user status and account type (admin only)

## Authentication

All protected routes require a JWT token in the Authorization header:

```
Authorization: Bearer <your_jwt_token>
```

## Client Integration

To integrate with the client, extend the `WorldStorageService.js` to communicate with the server. Here are examples for the main API operations:

```javascript
// Add to WorldStorageService.js
const API_URL = 'http://localhost:8797/api';
let authToken = localStorage.getItem('authToken');

// Authentication methods
async function register(username, password, email = null) {
  const userData = { username, password };
  if (email) userData.email = email;
  
  const response = await fetch(`${API_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userData)
  });
  const data = await response.json();
  if (response.ok) {
    authToken = data.token;
    localStorage.setItem('authToken', authToken);
    return { success: true, user: data.user };
  }
  return { success: false, error: data.error || 'Registration failed' };
}

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
    return { success: true, user: data.user };
  }
  return { success: false, error: data.error || 'Login failed' };
}

// World fetching methods
async function fetchRemoteWorlds(page = 1, limit = 10, search = '', tags = '', searchByAuthor = false, sort = 'created_at', order = 'desc') {
  let url = `${API_URL}/worlds?page=${page}&limit=${limit}`;
  if (search) url += `&search=${encodeURIComponent(search)}`;
  if (tags) url += `&tags=${encodeURIComponent(tags)}`;
  if (searchByAuthor) url += `&searchByAuthor=true`;
  if (sort) url += `&sort=${encodeURIComponent(sort)}`;
  if (order) url += `&order=${encodeURIComponent(order)}`;
  
  const response = await fetch(url, {
    headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
  });
  
  // Response will include thumbnailUrl for each world
  // Example: thumbnailUrl: "/api/thumbnails/abc123.jpg"
  // This URL can be used directly in <img> tags
  return await response.json();
}

async function getWorldContent(worldId) {
  const response = await fetch(`${API_URL}/worlds/${worldId}/content`, {
    headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
  });
  return await response.json();
}

async function uploadWorld(worldData) {
  if (!authToken) return { success: false, error: 'Not authenticated' };
  
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
      contentData: worldData,
      tags: worldData.worldOverview.tags || [],
      spoiler: worldData.worldOverview.spoiler || false
    })
  });
  const data = await response.json();
  return { success: response.ok, world: data.data, error: data.error };
}

// Set world spoiler status
async function setWorldSpoilerStatus(worldId, spoiler) {
  if (!authToken) return { success: false, error: 'Not authenticated' };
  
  const response = await fetch(`${API_URL}/worlds/${worldId}/spoiler`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`
    },
    body: JSON.stringify({ spoiler })
  });
  return await response.json();
}

// Comment methods
async function getWorldComments(worldId, page = 1, limit = 10) {
  const response = await fetch(`${API_URL}/worlds/${worldId}/comments?page=${page}&limit=${limit}`, {
    headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
  });
  return await response.json();
}

async function getWorldWithComments(worldId, commentsPage = 1, commentsLimit = 5) {
  const response = await fetch(`${API_URL}/worlds/${worldId}?includeComments=true&commentsPage=${commentsPage}&commentsLimit=${commentsLimit}`, {
    headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
  });
  return await response.json();
}

async function createComment(worldId, content) {
  if (!authToken) return { success: false, error: 'Not authenticated' };
  
  const response = await fetch(`${API_URL}/worlds/${worldId}/comments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`
    },
    body: JSON.stringify({ content })
  });
  return await response.json();
}

async function updateComment(commentId, content) {
  if (!authToken) return { success: false, error: 'Not authenticated' };
  
  const response = await fetch(`${API_URL}/comments/${commentId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`
    },
    body: JSON.stringify({ content })
  });
  return await response.json();
}

async function deleteComment(commentId) {
  if (!authToken) return { success: false, error: 'Not authenticated' };
  
  const response = await fetch(`${API_URL}/comments/${commentId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${authToken}`
    }
  });
  return await response.json();
}
```

## Differences from Previous Implementation

1. **Database**: SQLite instead of MongoDB for improved reliability and resistance to corruption
2. **Thumbnail Storage**: Thumbnails stored as separate files instead of base64 strings in the database
3. **File Organization**: Improved storage structure with separate directories for worlds and thumbnails
4. **Error Handling**: Enhanced error handling and validation
5. **Code Structure**: More modular and maintainable code organization
6. **Comments System**: Added ability for users to comment on worlds

## Security Considerations

1. All passwords are hashed using bcrypt
2. JWT tokens are used for authentication
3. Users can only modify their own worlds
4. Input validation is implemented for all API endpoints
5. Proper error handling prevents information leakage
