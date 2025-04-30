const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;

/**
 * Start an in-memory MongoDB server and return the connection URI
 * @returns {Promise<string>} The MongoDB connection URI
 */
const startInMemoryMongoDB = async () => {
  try {
    // Create a new instance of MongoMemoryServer
    mongoServer = await MongoMemoryServer.create();
    
    // Get the connection URI
    const uri = mongoServer.getUri();
    
    console.log(`In-Memory MongoDB Server started at: ${uri}`);
    
    return uri;
  } catch (error) {
    console.error(`Error starting in-memory MongoDB: ${error.message}`);
    throw error;
  }
};

/**
 * Stop the in-memory MongoDB server
 */
const stopInMemoryMongoDB = async () => {
  if (mongoServer) {
    await mongoServer.stop();
    console.log('In-Memory MongoDB Server stopped');
  }
};

module.exports = {
  startInMemoryMongoDB,
  stopInMemoryMongoDB
};
