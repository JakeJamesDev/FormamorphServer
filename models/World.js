const mongoose = require('mongoose');

const WorldSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please provide a world name'],
    trim: true,
    maxlength: [100, 'World name cannot exceed 100 characters']
  },
  description: {
    type: String,
    required: [true, 'Please provide a world description'],
    maxlength: [1000, 'World description cannot exceed 1000 characters']
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  thumbnail: {
    type: String,
    required: [true, 'Please provide a thumbnail image']
  },
  previewData: {
    type: Object,
    required: [true, 'Please provide preview data'],
    default: {}
  },
  contentData: {
    type: Object,
    required: [true, 'Please provide world content data'],
    default: {}
  },
  downloads: {
    type: Number,
    default: 0
  },
  tags: {
    type: [String],
    default: []
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update the updatedAt field before saving
WorldSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Create index for search functionality
WorldSchema.index({ name: 'text', description: 'text', tags: 'text' });

module.exports = mongoose.model('World', WorldSchema);
