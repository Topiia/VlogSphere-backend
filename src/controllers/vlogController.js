const Vlog = require('../models/Vlog');
const User = require('../models/User');
const asyncHandler = require('../middleware/asyncHandler');
const ErrorResponse = require('../utils/errorResponse');
const { generateTags } = require('../services/aiService');

/* ----------------------------------------------------------
   GET ALL VLOGS (Public)
---------------------------------------------------------- */
exports.getVlogs = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const startIndex = (page - 1) * limit;

  let query = { isPublic: true };

  if (req.query.category) query.category = req.query.category;
  if (req.query.tag) query.tags = { $in: [req.query.tag] };
  if (req.query.author) query.author = req.query.author;

  if (req.query.search && req.query.search.trim()) {
    query.$text = { $search: req.query.search.trim() };
  }

  if (req.query.dateFrom || req.query.dateTo) {
    query.createdAt = {};
    if (req.query.dateFrom) query.createdAt.$gte = new Date(req.query.dateFrom);
    if (req.query.dateTo) query.createdAt.$lte = new Date(req.query.dateTo);
  }

  let sortBy = '-createdAt';
  switch (req.query.sort) {
    case 'popular': sortBy = '-views'; break;
    case 'liked': sortBy = '-likes'; break;
    case 'oldest': sortBy = 'createdAt'; break;
    case 'alphabetical': sortBy = 'title'; break;
  }

  const vlogs = await Vlog.find(query)
    .populate('author', 'username avatar bio followerCount')
    .sort(sortBy)
    .skip(startIndex)
    .limit(limit)
    .lean();

  const total = await Vlog.countDocuments(query);
  const totalPages = Math.ceil(total / limit);

  if (req.user) {
    vlogs.forEach(v => {
      v.isLiked = v.likes?.some(id => id.toString() === req.user._id.toString());
      v.isDisliked = v.dislikes?.some(id => id.toString() === req.user._id.toString());
    });
  }

  res.status(200).json({
    success: true,
    count: vlogs.length,
    total,
    totalPages,
    currentPage: page,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
    data: vlogs
  });
});


/* ----------------------------------------------------------
   GET SINGLE VLOG
---------------------------------------------------------- */
exports.getVlog = asyncHandler(async (req, res, next) => {
  let vlog = await Vlog.findById(req.params.id)
    .populate('author', 'username avatar bio followerCount followers')
    .populate('comments.user', 'username avatar');

  if (!vlog) return next(new ErrorResponse('Vlog not found', 404));

  if (!vlog.isPublic && (!req.user || vlog.author._id.toString() !== req.user.id)) {
    return next(new ErrorResponse('Not authorized to view this vlog', 403));
  }

  if (vlog.comments && vlog.comments.length > 0) {
  vlog.comments.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

  // Record unique view if user is authenticated
  if (req.user) {
    await vlog.recordUniqueView(req.user.id);
    vlog.isLiked = vlog.likes.some(id => id.toString() === req.user._id.toString());
    vlog.isDisliked = vlog.dislikes.some(id => id.toString() === req.user._id.toString());
    vlog.hasViewed = vlog.userViews.some(id => id.toString() === req.user.id.toString());
  } else {
    // For unauthenticated users, just increment views
    await vlog.incrementViews();
  }

  // Convert to plain object to add isFollowedByCurrentUser
  const vlogData = vlog.toObject();
  
  // Add isFollowedByCurrentUser to author
  if (vlogData.author && req.user) {
    vlogData.author.isFollowedByCurrentUser = vlogData.author.followers.some(
      id => id.toString() === req.user.id.toString()
    );
  } else {
    vlogData.author.isFollowedByCurrentUser = false;
  }

  res.status(200).json({ success: true, data: vlogData });
});


/* ----------------------------------------------------------
   CREATE VLOG
---------------------------------------------------------- */
exports.createVlog = asyncHandler(async (req, res) => {
  req.body.author = req.user.id;

  if (req.files?.length > 0) {
    req.body.images = req.files.map((file, i) => ({
      url: file.path,
      publicId: file.filename || file.public_id,
      caption: req.body.captions?.[i] || '',
      order: i
    }));
  }

  if (
    process.env.AI_TAGGING_ENABLED === 'true' &&
    req.body.description &&
    req.body.description.length >= Number(process.env.MIN_DESCRIPTION_LENGTH)
  ) {
    try {
      const tags = await generateTags(req.body.description);
      req.body.tags = [...(req.body.tags || []), ...tags];
      req.body.aiGeneratedTags = true;
    } catch {
      req.body.aiGeneratedTags = false;
    }
  }

  let vlog = await Vlog.create(req.body);

  await vlog.populate('author', 'username avatar bio');

  res.status(201).json({ success: true, data: vlog });
});


/* ----------------------------------------------------------
   UPDATE VLOG
---------------------------------------------------------- */
exports.updateVlog = asyncHandler(async (req, res, next) => {
  let vlog = await Vlog.findById(req.params.id);

  if (!vlog) return next(new ErrorResponse('Vlog not found', 404));

  if (vlog.author.toString() !== req.user.id && req.user.role !== 'admin') {
    return next(new ErrorResponse('Not authorized to update this vlog', 403));
  }

  // Handle image updates
  let updatedImages = req.body.images || vlog.images;

  // If new images are uploaded, add them to existing images
  if (req.files?.length > 0) {
    const newImages = req.files.map((file, i) => ({
      url: file.path,
      publicId: file.filename || file.public_id,
      caption: req.body.captions?.[i] || '',
      order: updatedImages.length + i
    }));

    updatedImages = [...updatedImages, ...newImages];
  }

  // Validate image count (max 10)
  if (updatedImages.length > 10) {
    return next(new ErrorResponse('Cannot have more than 10 images', 400));
  }

  // Validate minimum image requirement (at least 1)
  if (updatedImages.length === 0) {
    return next(new ErrorResponse('At least one image is required', 400));
  }

  req.body.images = updatedImages;

  // AI tagging if enabled
  if (req.body.description && process.env.AI_TAGGING_ENABLED === 'true') {
    try {
      const tags = await generateTags(req.body.description);
      req.body.tags = [...(req.body.tags || []), ...tags];
      req.body.aiGeneratedTags = true;
    } catch {}
  }

  vlog = await Vlog.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true
  }).populate('author', 'username avatar bio');

  res.status(200).json({ success: true, data: vlog });
});


/* ----------------------------------------------------------
   DELETE VLOG (with image cleanup)
---------------------------------------------------------- */
exports.deleteVlog = asyncHandler(async (req, res, next) => {
  const vlog = await Vlog.findById(req.params.id);

  if (!vlog) return next(new ErrorResponse('Vlog not found', 404));

  if (vlog.author.toString() !== req.user.id && req.user.role !== 'admin') {
    return next(new ErrorResponse('Not authorized to delete this vlog', 403));
  }

  // Clean up images from Cloudinary
  if (vlog.images?.length > 0) {
    const { deleteImage } = require('../middleware/upload');
    for (const img of vlog.images) {
      try {
        await deleteImage(img.publicId);
      } catch (error) {
        // Log error but continue with deletion
        console.error(`Failed to delete image ${img.publicId}:`, error.message);
      }
    }
  }

  await vlog.deleteOne();

  res.status(200).json({ 
    success: true, 
    message: 'Vlog deleted successfully',
    data: {} 
  });
});


/* ----------------------------------------------------------
   TOGGLE LIKE
---------------------------------------------------------- */
exports.toggleLike = asyncHandler(async (req, res, next) => {
  const vlog = await Vlog.findById(req.params.id);

  if (!vlog) return next(new ErrorResponse('Vlog not found', 404));

  await vlog.toggleLike(req.user.id);

  res.status(200).json({
    success: true,
    data: {
      likeCount: vlog.likeCount,
      dislikeCount: vlog.dislikeCount,
      isLiked: vlog.likes.some(id => id.toString() === req.user.id.toString()),
      isDisliked: vlog.dislikes.some(id => id.toString() === req.user.id.toString())
    }
  });
});


/* ----------------------------------------------------------
   TOGGLE DISLIKE
---------------------------------------------------------- */
exports.toggleDislike = asyncHandler(async (req, res, next) => {
  const vlog = await Vlog.findById(req.params.id);

  if (!vlog) return next(new ErrorResponse('Vlog not found', 404));

  await vlog.toggleDislike(req.user.id);

  res.status(200).json({
    success: true,
    data: {
      likeCount: vlog.likeCount,
      dislikeCount: vlog.dislikeCount,
      isLiked: vlog.likes.some(id => id.toString() === req.user.id.toString()),
      isDisliked: vlog.dislikes.some(id => id.toString() === req.user.id.toString())
    }
  });
});


/* ----------------------------------------------------------
   ADD COMMENT
---------------------------------------------------------- */
exports.addComment = asyncHandler(async (req, res, next) => {
  const vlog = await Vlog.findById(req.params.id);

  if (!vlog) return next(new ErrorResponse('Vlog not found', 404));

  vlog.comments.push({
    user: req.user.id,
    text: req.body.text,
    createdAt: new Date()
  });

  await vlog.save();
  await vlog.populate('comments.user', 'username avatar');

  const newComment = vlog.comments[vlog.comments.length - 1];

  res.status(201).json({ success: true, data: newComment });
});


/* ----------------------------------------------------------
   DELETE COMMENT
---------------------------------------------------------- */
exports.deleteComment = asyncHandler(async (req, res, next) => {
  const vlog = await Vlog.findById(req.params.id);

  if (!vlog) return next(new ErrorResponse('Vlog not found', 404));

  const comment = vlog.comments.id(req.params.commentId);
  if (!comment) return next(new ErrorResponse('Comment not found', 404));

  if (comment.user.toString() !== req.user.id && vlog.author.toString() !== req.user.id) {
    return next(new ErrorResponse('Not authorized', 403));
  }

  comment.remove();
  await vlog.save();

  res.status(200).json({ success: true, data: {} });
});


/* ----------------------------------------------------------
   INCREMENT SHARE COUNT
---------------------------------------------------------- */
exports.incrementShare = asyncHandler(async (req, res, next) => {
  const vlog = await Vlog.findById(req.params.id);

  if (!vlog) {
    return next(new ErrorResponse('Vlog not found', 404));
  }

  vlog.shares += 1;
  await vlog.save();

  res.status(200).json({
    success: true,
    data: { shares: vlog.shares }
  });
});


/* ----------------------------------------------------------
   TRENDING VLOGS
---------------------------------------------------------- */
exports.getTrendingVlogs = asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const timeframe = parseInt(req.query.timeframe) || 7;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - timeframe);

  const vlogs = await Vlog.aggregate([
    { $match: { isPublic: true, createdAt: { $gte: cutoff } } },
    {
      $addFields: {
        engagementScore: {
          $add: [
            { $multiply: ['$views', 0.1] },
            { $multiply: [{ $size: '$likes' }, 2] },
            { $multiply: [{ $size: '$comments' }, 3] },
            { $multiply: [{ $ifNull: ['$shares', 0] }, 5] }
          ]
        }
      }
    },
    { $sort: { engagementScore: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'users',
        localField: 'author',
        foreignField: '_id',
        as: 'author',
        pipeline: [{ $project: { username: 1, avatar: 1, bio: 1 } }]
      }
    },
    { $unwind: '$author' }
  ]);

  res.status(200).json({ success: true, count: vlogs.length, data: vlogs });
});


/* ----------------------------------------------------------
   GET USER'S PUBLIC VLOGS
---------------------------------------------------------- */
exports.getUserVlogs = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  const vlogs = await Vlog.find({ author: req.params.userId, isPublic: true })
    .populate('author', 'username avatar bio')
    .sort('-createdAt')
    .skip(skip)
    .limit(limit);

  const total = await Vlog.countDocuments({ author: req.params.userId, isPublic: true });
  const totalPages = Math.ceil(total / limit);

  if (req.user) {
    vlogs.forEach(v => {
      v.isLiked = v.likes.some(id => id.toString() === req.user._id.toString());
      v.isDisliked = v.dislikes.some(id => id.toString() === req.user._id.toString());
    });
  }

  res.status(200).json({
    success: true,
    count: vlogs.length,
    total,
    totalPages,
    currentPage: page,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
    data: vlogs
  });
});


/* ----------------------------------------------------------
   RECORD VIEW (Explicit endpoint)
---------------------------------------------------------- */
exports.recordView = asyncHandler(async (req, res, next) => {
  const vlog = await Vlog.findById(req.params.id);

  if (!vlog) {
    return next(new ErrorResponse('Vlog not found', 404));
  }

  // Record unique view if user is authenticated
  if (req.user) {
    await vlog.recordUniqueView(req.user.id);
  }

  res.status(200).json({
    success: true,
    data: {
      views: vlog.views,
      hasViewed: req.user ? vlog.userViews.some(id => id.toString() === req.user.id.toString()) : false
    }
  });
});
