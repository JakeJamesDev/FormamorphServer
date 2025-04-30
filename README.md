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

## Installation & Setup

### Prerequisites
- Node.js (v14 or higher)
- npm or yarn
- MongoDB (installed and running locally)

### Installation

1. Clone the repository or navigate to the server directory
2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
   - Create a `.env` file in the root directory with the following variables (or use the existing one):
   ```
   PORT=8797
   MONGODB_URI=mongodb://localhost:27017/exotic-dangerous
   JWT_SECRET=your_jwt_secret_key_change_this_in_production
   JWT_EXPIRE=24h
   NODE_ENV=development
   ```

4. Ensure MongoDB is running:
   - The application requires a running MongoDB instance
   - The default connection string is `mongodb://localhost:27017/exotic-dangerous`
   - The database and collections will be created automatically when the application connects

5. Configure admin account (optional):
   - By default, the server creates an admin account on first startup with the following credentials:
     - Username: `admin`
     - Password: `admin123`
     - Email: `admin@example.com`
   - You can customize these values by adding the following to your `.env` file:
   ```
   ADMIN_USERNAME=your_admin_username
   ADMIN_PASSWORD=your_admin_password
   ADMIN_EMAIL=your_admin_email
   ```
   - It is highly recommended to change these default values in production environments

### Creating Additional Admin Accounts

There are two ways to create additional admin accounts:

1. **Using the Admin API** (requires an existing admin account):
   - Login with an existing admin account
   - Use the `PUT /api/users/:id/status` endpoint to promote a user to admin:
   ```
   PUT /api/users/user_id_here/status
   {
     "accountType": "admin"
   }
   ```

2. **Manually in MongoDB**:
   - Connect to your MongoDB instance
   - Update a user document in the `users` collection:
   ```javascript
   db.users.updateOne(
     { username: "username_to_promote" },
     { $set: { accountType: "admin" } }
   )
   ```

6. Start the server:
```bash
npm start
```

For development with auto-restart:
```bash
npm run dev
```

### Database Management

To reset the database (this will delete all data and recreate the admin account):
```bash
npm run reset-db
```

This command:
1. Drops all collections in the MongoDB database
2. Re-seeds the admin user with the credentials specified in your `.env` file
3. Provides a clean slate for testing or development

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register a new user
  - Required parameters:
    - `username`: String (3-20 characters)
    - `password`: String (minimum 6 characters)
  - Optional parameters:
    - `email`: String (valid email format)
  - Returns: 
    ```json
    {
      "success": true,
      "token": "jwt_token_string",
      "user": {
        "id": "user_id",
        "username": "username",
        "email": "user@example.com",
        "status": "normal",
        "accountType": "normal"
      }
    }
    ```

- `POST /api/auth/login` - Login and get JWT token
  - Required parameters:
    - `username`: String
    - `password`: String
  - Returns: 
    ```json
    {
      "success": true,
      "token": "jwt_token_string",
      "user": {
        "id": "user_id",
        "username": "username",
        "email": "user@example.com",
        "status": "normal",
        "accountType": "normal"
      }
    }
    ```

- `POST /api/auth/change-password` - Change password (requires authentication)
  - Required parameters:
    - `currentPassword`: String
    - `newPassword`: String (minimum 6 characters)
  - Returns: 
    ```json
    {
      "success": true,
      "message": "Password updated successfully"
    }
    ```

- `GET /api/auth/me` - Get current user profile (requires authentication)
  - No parameters required
  - Returns: 
    ```json
    {
      "success": true,
      "user": {
        "id": "user_id",
        "username": "username",
        "email": "user@example.com",
        "status": "normal",
        "accountType": "normal",
        "createdAt": "2025-04-29T19:30:00.000Z"
      }
    }
    ```

### World Management
- `GET /api/worlds` - List worlds with filtering options
  - Query parameters:
    - `search`: String - Search by name, description, or tags (default) or by author name when searchByAuthor is true. Supports partial matches (e.g., "sugar" will match "Sugarscape")
    - `searchByAuthor`: Boolean - When set to 'true', the search parameter will search by author username instead of world name/description/tags
    - `tags`: String - Comma-separated list of tags to filter by
    - `page`: Number - Page number for pagination (default: 1)
    - `limit`: Number - Number of results per page (default: 10)
  - Returns: 
    ```json
    {
      "success": true,
      "count": 5,
      "pagination": {
        "next": { "page": 2, "limit": 10 },
        "prev": { "page": 1, "limit": 10 }
      },
      "total": 25,
      "data": [
        {
          "id": "world_id",
          "name": "World Name",
          "description": "World Description",
          "thumbnail": "base64_encoded_image",
          "downloads": 42,
          "tags": ["adventure", "puzzle"],
          "createdAt": "2025-04-29T19:30:00.000Z",
          "updatedAt": "2025-04-29T19:30:00.000Z",
          "author": {
            "id": "user_id",
            "username": "creator_username"
          }
        },
        ...
      ]
    }
    ```

- `GET /api/worlds/:id` - Get world details
  - URL parameters:
    - `id`: String - World ID
  - Returns: 
    ```json
    {
      "success": true,
      "data": {
        "id": "world_id",
        "name": "World Name",
        "description": "World Description",
        "thumbnail": "base64_encoded_image",
        "downloads": 42,
        "tags": ["adventure", "puzzle"],
        "createdAt": "2025-04-29T19:30:00.000Z",
        "updatedAt": "2025-04-29T19:30:00.000Z",
        "author": {
          "id": "user_id",
          "username": "creator_username"
        }
      }
    }
    ```

- `GET /api/worlds/:id/content` - Download world content, this downloads the entire world object as-is
  - URL parameters:
    - `id`: String - World ID
  - Returns: 
    ```json
    {
      "success": true,
      "data": {
        "id": "world_id",
        "name": "World Name",
        "description": "World Description",
        "thumbnail": "base64_encoded_image",
        "previewData": { ... },
        "contentData": { ... },
        "downloads": 42,
        "tags": ["adventure", "puzzle"],
        "createdAt": "2025-04-29T19:30:00.000Z",
        "updatedAt": "2025-04-29T19:30:00.000Z",
        "author": "user_id"
      }
    }
    ```

- `POST /api/worlds` - Create/upload a new world (requires authentication)
  - Required parameters:
    - `name`: String (max 100 characters)
    - `description`: String (max 1000 characters)
    - `thumbnail`: String (base64 encoded image)
    - `previewData`: Object - Preview data for the world
    - `contentData`: Object - Full world content data
  - Optional parameters:
    - `tags`: Array of Strings - Tags for categorizing the world
  - Returns: 
    ```json
    {
      "success": true,
      "data": {
        "id": "world_id",
        "name": "World Name",
        "description": "World Description",
        "thumbnail": "base64_encoded_image",
        "previewData": { ... },
        "contentData": { ... },
        "downloads": 0,
        "tags": ["adventure", "puzzle"],
        "createdAt": "2025-04-29T19:30:00.000Z",
        "updatedAt": "2025-04-29T19:30:00.000Z",
        "author": "user_id"
      }
    }
    ```

- `PUT /api/worlds/:id` - Update world metadata or content (requires authentication, owner or admin only)
  - URL parameters:
    - `id`: String - World ID
  - Optional parameters (at least one required):
    - `name`: String (max 100 characters)
    - `description`: String (max 1000 characters)
    - `thumbnail`: String (base64 encoded image)
    - `previewData`: Object - Preview data for the world
    - `contentData`: Object - Full world content data
    - `tags`: Array of Strings - Tags for categorizing the world
  - Returns: 
    ```json
    {
      "success": true,
      "data": {
        "id": "world_id",
        "name": "Updated World Name",
        "description": "Updated World Description",
        "thumbnail": "base64_encoded_image",
        "previewData": { ... },
        "contentData": { ... },
        "downloads": 42,
        "tags": ["adventure", "puzzle", "new_tag"],
        "createdAt": "2025-04-29T19:30:00.000Z",
        "updatedAt": "2025-04-29T19:35:00.000Z",
        "author": "user_id"
      }
    }
    ```

- `DELETE /api/worlds/:id` - Delete a world (requires authentication, owner or admin only)
  - URL parameters:
    - `id`: String - World ID
  - Returns: 
    ```json
    {
      "success": true,
      "data": {}
    }
    ```

### User Management
- `GET /api/users/:id/worlds` - Get worlds created by a specific user
  - URL parameters:
    - `id`: String - User ID
  - Returns: 
    ```json
    {
      "success": true,
      "count": 3,
      "data": [
        {
          "id": "world_id",
          "name": "World Name",
          "description": "World Description",
          "thumbnail": "base64_encoded_image",
          "downloads": 42,
          "tags": ["adventure", "puzzle"],
          "createdAt": "2025-04-29T19:30:00.000Z",
          "updatedAt": "2025-04-29T19:30:00.000Z"
        },
        ...
      ]
    }
    ```

- `GET /api/users/me` - Get current user profile (requires authentication)
  - No parameters required
  - Returns: 
    ```json
    {
      "success": true,
      "user": {
        "id": "user_id",
        "username": "username",
        "email": "user@example.com",
        "status": "normal",
        "accountType": "normal",
        "createdAt": "2025-04-29T19:30:00.000Z"
      }
    }
    ```

- `GET /api/users/me/worlds` - Get worlds created by the current user (requires authentication)
  - No parameters required
  - Returns: 
    ```json
    {
      "success": true,
      "count": 3,
      "data": [
        {
          "id": "world_id",
          "name": "World Name",
          "description": "World Description",
          "thumbnail": "base64_encoded_image",
          "downloads": 42,
          "tags": ["adventure", "puzzle"],
          "createdAt": "2025-04-29T19:30:00.000Z",
          "updatedAt": "2025-04-29T19:30:00.000Z"
        },
        ...
      ]
    }
    ```

- `GET /api/users` - Get all users (requires authentication, admin only)
  - No parameters required
  - Returns: 
    ```json
    {
      "success": true,
      "count": 3,
      "data": [
        {
          "id": "user_id",
          "username": "username",
          "email": "user@example.com",
          "status": "normal",
          "accountType": "normal",
          "createdAt": "2025-04-29T19:30:00.000Z",
          "updatedAt": "2025-04-29T19:30:00.000Z"
        },
        ...
      ]
    }
    ```

- `PUT /api/users/:id/status` - Update user status and account type (requires authentication, admin only)
  - URL parameters:
    - `id`: String - User ID
  - Optional parameters (at least one required):
    - `status`: String - User status (normal, flagged, or suspended)
    - `accountType`: String - Account type (normal or admin)
  - Returns: 
    ```json
    {
      "success": true,
      "user": {
        "id": "user_id",
        "username": "username",
        "email": "user@example.com",
        "status": "flagged",
        "accountType": "normal",
        "createdAt": "2025-04-29T19:30:00.000Z",
        "updatedAt": "2025-04-29T19:35:00.000Z"
      }
    }
    ```

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

async function changePassword(currentPassword, newPassword) {
  if (!authToken) return { success: false, error: 'Not authenticated' };
  
  const response = await fetch(`${API_URL}/auth/change-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`
    },
    body: JSON.stringify({ currentPassword, newPassword })
  });
  const data = await response.json();
  return { success: response.ok, message: data.message, error: data.error };
}

async function getProfile() {
  if (!authToken) return { success: false, error: 'Not authenticated' };
  
  const response = await fetch(`${API_URL}/auth/me`, {
    headers: { 'Authorization': `Bearer ${authToken}` }
  });
  const data = await response.json();
  return { success: response.ok, user: data.user, error: data.error };
}

// World management methods
async function fetchRemoteWorlds(page = 1, limit = 10, search = '', tags = '', searchByAuthor = false) {
  let url = `${API_URL}/worlds?page=${page}&limit=${limit}`;
  if (search) url += `&search=${encodeURIComponent(search)}`;
  if (tags) url += `&tags=${encodeURIComponent(tags)}`;
  if (searchByAuthor) url += `&searchByAuthor=true`;
  
  const response = await fetch(url, {
    headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
  });
  return await response.json();
}

async function getWorldDetails(worldId) {
  const response = await fetch(`${API_URL}/worlds/${worldId}`, {
    headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
  });
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
      tags: worldData.worldOverview.tags || []
    })
  });
  const data = await response.json();
  return { success: response.ok, world: data.data, error: data.error };
}

async function updateWorld(worldId, updateData) {
  if (!authToken) return { success: false, error: 'Not authenticated' };
  
  const response = await fetch(`${API_URL}/worlds/${worldId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`
    },
    body: JSON.stringify(updateData)
  });
  const data = await response.json();
  return { success: response.ok, world: data.data, error: data.error };
}

async function deleteWorld(worldId) {
  if (!authToken) return { success: false, error: 'Not authenticated' };
  
  const response = await fetch(`${API_URL}/worlds/${worldId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${authToken}` }
  });
  const data = await response.json();
  return { success: response.ok, error: data.error };
}

// User worlds methods
async function getUserWorlds(userId) {
  const response = await fetch(`${API_URL}/users/${userId}/worlds`, {
    headers: authToken ? { 'Authorization': `Bearer ${authToken}` } : {}
  });
  return await response.json();
}

async function getMyWorlds() {
  if (!authToken) return { success: false, error: 'Not authenticated' };
  
  const response = await fetch(`${API_URL}/users/me/worlds`, {
    headers: { 'Authorization': `Bearer ${authToken}` }
  });
  return await response.json();
}

// Admin methods
async function getAllUsers() {
  if (!authToken) return { success: false, error: 'Not authenticated' };
  
  const response = await fetch(`${API_URL}/users`, {
    headers: { 'Authorization': `Bearer ${authToken}` }
  });
  const data = await response.json();
  return { success: response.ok, users: data.data, count: data.count, error: data.error };
}

async function updateUserStatus(userId, status, accountType) {
  if (!authToken) return { success: false, error: 'Not authenticated' };
  
  const updateData = {};
  if (status) updateData.status = status;
  if (accountType) updateData.accountType = accountType;
  
  const response = await fetch(`${API_URL}/users/${userId}/status`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`
    },
    body: JSON.stringify(updateData)
  });
  const data = await response.json();
  return { success: response.ok, user: data.user, error: data.error };
}
