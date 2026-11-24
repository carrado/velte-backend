import mongoose from "mongoose";
import jwt from "jsonwebtoken";

import Gig from "../../models/Gig.model.js";
import GigApplication from "../../models/GigApplication.model.js";
import Store from "../../models/Store.model.js";
import User from "../../models/Users.js";
import Buyer from "../../models/Buyer.model.js";
import Credits from "../../models/Credits.model.js";
import { notifyOwner, notifyUser } from "../../services/pushNotification.service.js";
import { AppError } from "../../middleware/errorHandler.js";

/**
 * List all live gigs available on the platform
 */
export async function listGigs(req, res, next) {
  try {
    const { category, workMode, search } = req.query;
    const filter = { status: { $in: ["open", "assigned"] } };

    if (category && category !== "all") {
      filter.category = category;
    }
    if (workMode && workMode !== "all") {
      filter.workMode = workMode;
    }
    if (search && typeof search === "string" && search.trim()) {
      filter.$or = [
        { title: { $regex: search.trim(), $options: "i" } },
        { description: { $regex: search.trim(), $options: "i" } },
        { location: { $regex: search.trim(), $options: "i" } },
      ];
    }

    const gigs = await Gig.find(filter)
      .sort({ createdAt: -1 })
      .limit(60)
      .lean();

    const vendorIds = [...new Set(gigs.map((g) => String(g.vendorId)))];
    const [stores, users] = await Promise.all([
      vendorIds.length
        ? Store.find({ vendorId: { $in: vendorIds } })
          .select("vendorId name handle avatar locations")
          .lean()
        : [],
      vendorIds.length
        ? User.find({ _id: { $in: vendorIds } })
          .select("name avatar company verification verificationStatus isVerified")
          .lean()
        : [],
    ]);

    const storeMap = new Map(stores.map((s) => [String(s.vendorId), s]));
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    // If caller is an authenticated buyer, look up which gigs they've already applied to
    let myApplicationsMap = new Map();
    if (req.actor && req.actor.id) {
      const gigIds = gigs.map((g) => g._id);
      const myApps = await GigApplication.find({
        gigId: { $in: gigIds },
        buyerId: req.actor.id,
      })
        .select("gigId status")
        .lean();
      myApplicationsMap = new Map(
        myApps.map((a) => [String(a.gigId), a.status]),
      );
    }

    const results = gigs.map((g) => {
      const store = storeMap.get(String(g.vendorId));
      const user = userMap.get(String(g.vendorId));
      const myAppStatus = myApplicationsMap.get(String(g._id)) || null;
      const v = user?.verification || {};
      const isVerified = Boolean(
        v.ninVerifiedAt ||
        v.cacReviewedAt ||
        v.status === "verified" ||
        user?.verificationStatus === "verified" ||
        user?.isVerified
      );

      return {
        id: String(g._id),
        title: g.title,
        description: g.description,
        category: g.category,
        workMode: g.workMode,
        location: g.location,
        rewardType: g.rewardType,
        rewardKobo: g.rewardKobo,
        milestones: g.milestones,
        deadline: g.deadline,
        requiredSkills: g.requiredSkills,
        status: g.status,
        applicantCount: g.applicantCount || 0,
        imageUrl: g.imageUrl || store?.avatar || user?.avatar || null,
        images: g.images && g.images.length ? g.images : (store?.gallery || []),
        createdAt: g.createdAt,
        vendor: {
          vendorId: String(g.vendorId),
          name: store?.name || user?.company?.name || user?.name || "Verified Vendor",
          handle: store?.handle || null,
          avatar: store?.avatar || user?.avatar || null,
          verified: isVerified,
        },
        hasApplied: Boolean(myAppStatus),
        myApplicationStatus: myAppStatus,
      };
    });

    res.json({ success: true, data: results });
  } catch (err) {
    next(err);
  }
}

/**
 * Get details of a single gig
 */
export async function getGigDetails(req, res, next) {
  try {
    const gig = await Gig.findById(req.params.id).lean();
    if (!gig) throw new AppError("Gig not found.", 404);

    const [store, user] = await Promise.all([
      Store.findOne({ vendorId: gig.vendorId })
        .select("vendorId name handle avatar locations whatsapp")
        .lean(),
      User.findById(gig.vendorId)
        .select("name avatar company verification")
        .lean(),
    ]);

    let myApplication = null;
    if (req.actor && req.actor.id) {
      myApplication = await GigApplication.findOne({
        gigId: gig._id,
        buyerId: req.actor.id,
      }).lean();
    }

    // If caller is the vendor who owns this gig, load all applicant proposals
    let applications = null;
    let vendorActorId = req.actor?.type === "vendor" ? req.actor.id : null;
    if (!vendorActorId && req.cookies?.auth_token) {
      try {
        const decoded = jwt.verify(req.cookies.auth_token, process.env.JWT_SECRET);
        if (decoded.userId && decoded.type !== "buyer") vendorActorId = decoded.userId;
      } catch {}
    }

    if (vendorActorId && String(gig.vendorId) === String(vendorActorId)) {
      const apps = await GigApplication.find({ gigId: gig._id })
        .sort({ createdAt: -1 })
        .lean();
      const buyerIds = apps.map((a) => a.buyerId);
      const buyers = await Buyer.find({ _id: { $in: buyerIds } })
        .select("name email phone avatar tier")
        .lean();
      const buyerMap = new Map(buyers.map((b) => [String(b._id), b]));
      applications = apps.map((a) => ({
        id: String(a._id),
        buyerId: String(a.buyerId),
        buyer: buyerMap.get(String(a.buyerId)) || null,
        pitch: a.pitch,
        proposedDuration: a.proposedDuration,
        contactPhone: a.contactPhone,
        status: a.status,
        submissionProof: a.submissionProof,
        createdAt: a.createdAt,
      }));
    }

    res.json({
      success: true,
      data: {
        id: String(gig._id),
        title: gig.title,
        description: gig.description,
        category: gig.category,
        workMode: gig.workMode,
        location: gig.location,
        rewardType: gig.rewardType,
        rewardKobo: gig.rewardKobo,
        milestones: gig.milestones,
        deadline: gig.deadline,
        requiredSkills: gig.requiredSkills,
        status: gig.status,
        applicantCount: gig.applicantCount || 0,
        imageUrl: gig.imageUrl || store?.avatar || user?.avatar || null,
        images: gig.images && gig.images.length ? gig.images : (store?.gallery || []),
        createdAt: gig.createdAt,
        vendor: {
          vendorId: String(gig.vendorId),
          name: store?.name || user?.company?.name || user?.name || "Verified Vendor",
          handle: store?.handle || null,
          avatar: store?.avatar || user?.avatar || null,
          verified: Boolean(user?.verification?.status === "verified"),
        },
        applications,
        myApplication: myApplication
          ? {
            id: String(myApplication._id),
            status: myApplication.status,
            pitch: myApplication.pitch,
            proposedDuration: myApplication.proposedDuration,
            submissionProof: myApplication.submissionProof,
            payoutStatus: myApplication.payoutStatus,
            payoutKobo: myApplication.payoutKobo,
            createdAt: myApplication.createdAt,
          }
          : null,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Buyer applies for a gig
 */
export async function applyForGig(req, res, next) {
  try {
    if (!req.actor || !req.actor.id) {
      throw new AppError("Sign in to apply for this gig.", 401);
    }

    const gig = await Gig.findById(req.params.id);
    if (!gig) throw new AppError("Gig not found.", 404);
    if (gig.status !== "open") {
      throw new AppError("This gig is no longer accepting applications.", 400);
    }

    // Check if buyer has already applied
    const existing = await GigApplication.findOne({
      gigId: gig._id,
      buyerId: req.actor.id,
    });
    if (existing) {
      throw new AppError("You have already submitted a proposal for this gig.", 400);
    }

    const pitch = typeof req.body?.pitch === "string" ? req.body.pitch.trim() : "";
    if (pitch.length < 10) {
      throw new AppError("Please write a pitch of at least 10 characters explaining why you're a good fit.", 400);
    }
    const proposedDuration = typeof req.body?.proposedDuration === "string"
      ? req.body.proposedDuration.trim()
      : "2-3 days";
    const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : null;

    const application = await GigApplication.create({
      gigId: gig._id,
      buyerId: req.actor.id,
      pitch,
      proposedDuration,
      phone,
      status: "pending",
      payoutKobo: gig.rewardKobo,
    });

    await Gig.updateOne({ _id: gig._id }, { $inc: { applicantCount: 1 } });

    // Notify vendor
    try {
      const buyer = await Buyer.findById(req.actor.id).select("name").lean();
      await notifyUser(String(gig.vendorId), {
        title: "New Gig Proposal Received",
        body: `${buyer?.name || "A buyer"} applied for your task: "${gig.title}". Review their proposal now!`,
        url: `/hub`,
        tag: `gig_app_${gig._id}`,
        type: "system",
      });
    } catch (notifErr) {
      console.warn("⚠️ Failed to notify vendor of gig application:", notifErr.message);
    }

    res.status(201).json({
      success: true,
      data: {
        id: String(application._id),
        status: application.status,
        message: "Application submitted successfully! The vendor will review your proposal.",
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * List all gigs applied to or won by the logged in buyer
 */
export async function listMyBuyerGigs(req, res, next) {
  try {
    if (!req.actor || !req.actor.id) {
      throw new AppError("Sign in to view your gigs.", 401);
    }

    const candidateIds = [req.actor.id];
    if (req.actor.type === "buyer") {
      const b = await Buyer.findById(req.actor.id).select("linkedVendorId").lean();
      if (b?.linkedVendorId) candidateIds.push(String(b.linkedVendorId));
    }

    const applications = await GigApplication.find({
      buyerId: { $in: candidateIds },
    })
      .sort({ createdAt: -1 })
      .lean();

    const gigIds = applications.map((a) => a.gigId);
    const gigs = await Gig.find({ _id: { $in: gigIds } }).lean();
    const gigMap = new Map(gigs.map((g) => [String(g._id), g]));

    const vendorIds = [...new Set(gigs.map((g) => String(g.vendorId)))];
    const [stores, users] = await Promise.all([
      vendorIds.length
        ? Store.find({ vendorId: { $in: vendorIds } })
          .select("vendorId name handle avatar")
          .lean()
        : [],
      vendorIds.length
        ? User.find({ _id: { $in: vendorIds } })
          .select("name avatar company")
          .lean()
        : [],
    ]);
    const storeMap = new Map(stores.map((s) => [String(s.vendorId), s]));
    const userMap = new Map(users.map((u) => [String(u._id), u]));

    const list = applications.map((app) => {
      const gig = gigMap.get(String(app.gigId));
      const store = gig ? storeMap.get(String(gig.vendorId)) : null;
      const user = gig ? userMap.get(String(gig.vendorId)) : null;

      return {
        applicationId: String(app._id),
        gigId: String(app.gigId),
        title: gig?.title || "Vendor Task",
        category: gig?.category || "custom",
        workMode: gig?.workMode || "on-site",
        location: gig?.location || "Nigeria",
        rewardKobo: gig?.rewardKobo || app.payoutKobo || 0,
        rewardType: gig?.rewardType || "instant",
        status: app.status, // "pending" | "accepted" | "rejected" | "submitted" | "completed"
        isWon: ["accepted", "submitted", "completed"].includes(app.status),
        payoutStatus: app.payoutStatus,
        pitch: app.pitch,
        proposedDuration: app.proposedDuration,
        submissionProof: app.submissionProof,
        createdAt: app.createdAt,
        updatedAt: app.updatedAt,
        vendor: {
          vendorId: gig ? String(gig.vendorId) : "",
          name: store?.name || user?.company?.name || user?.name || "Vendor",
          handle: store?.handle || null,
          avatar: store?.avatar || user?.avatar || null,
        },
      };
    });

    const totalWon = list.filter((g) => g.isWon).length;
    const activeTasks = list.filter((g) => ["accepted", "submitted"].includes(g.status)).length;
    const completedTasks = list.filter((g) => g.status === "completed").length;
    const totalEarnedKobo = list
      .filter((g) => g.payoutStatus === "released")
      .reduce((sum, g) => sum + (g.rewardKobo || 0), 0);

    res.json({
      success: true,
      data: {
        gigs: list,
        metrics: {
          totalWon,
          activeTasks,
          completedTasks,
          totalEarnedKobo,
        },
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Buyer submits proof of work for an assigned/won gig
 */
export async function submitGigWork(req, res, next) {
  try {
    if (!req.actor || !req.actor.id) {
      throw new AppError("Sign in to submit your work.", 401);
    }

    const { notes, photos = [], links = [] } = req.body || {};
    if (!notes || notes.trim().length < 5) {
      throw new AppError("Please provide a summary of the work completed.", 400);
    }

    const gig = await Gig.findById(req.params.id);
    if (!gig) throw new AppError("Gig not found.", 404);

    const application = await GigApplication.findOne({
      gigId: gig._id,
      buyerId: req.actor.id,
      status: { $in: ["accepted", "submitted"] },
    });

    if (!application) {
      throw new AppError("You have not been awarded this gig or it is not currently in progress.", 403);
    }

    application.status = "submitted";
    application.submissionProof = {
      notes: notes.trim(),
      photos: Array.isArray(photos) ? photos : [],
      links: Array.isArray(links) ? links : [],
      submittedAt: new Date(),
    };
    await application.save();

    gig.status = "submitted";
    await gig.save();

    // Notify vendor
    try {
      const buyer = await Buyer.findById(req.actor.id).select("name").lean();
      await notifyUser(String(gig.vendorId), {
        title: "Proof of Work Submitted!",
        body: `${buyer?.name || "Your gig agent"} submitted completion proof for "${gig.title}". Review and release payout.`,
        url: `/hub`,
        tag: `gig_sub_${gig._id}`,
        type: "system",
      });
    } catch (notifErr) {
      console.warn("⚠️ Failed to notify vendor of submission:", notifErr.message);
    }

    res.json({
      success: true,
      data: {
        message: "Work submitted successfully! The vendor has been notified to inspect and release your payout.",
        applicationStatus: "submitted",
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Vendor awards/assigns the gig to a specific applicant ("Buyer Wins Gig")
 */
export async function assignGig(req, res, next) {
  try {
    const { applicationId } = req.body;
    if (!applicationId) throw new AppError("Specify an applicant to assign.", 400);

    const gig = await Gig.findById(req.params.id);
    if (!gig) throw new AppError("Gig not found.", 404);
    let vendorId = req.actor?.type === "vendor" ? req.actor.id : null;
    if (!vendorId && req.cookies?.auth_token) {
      try {
        const decoded = jwt.verify(req.cookies.auth_token, process.env.JWT_SECRET);
        if (decoded.userId && decoded.type !== "buyer") vendorId = decoded.userId;
      } catch {}
    }
    if (String(gig.vendorId) !== String(vendorId)) {
      throw new AppError("You can only assign your own gigs.", 403);
    }

    const application = await GigApplication.findById(applicationId);
    if (!application || String(application.gigId) !== String(gig._id)) {
      throw new AppError("Application not found for this gig.", 404);
    }

    // Set application to accepted and gig to assigned
    application.status = "accepted";
    await application.save();

    // Reject other pending applications for this gig
    await GigApplication.updateMany(
      { gigId: gig._id, _id: { $ne: application._id }, status: "pending" },
      { $set: { status: "rejected" } },
    );

    gig.status = "assigned";
    gig.assignedBuyerId = application.buyerId;
    gig.assignedApplicationId = application._id;
    await gig.save();

    // Notify Buyer that they won the gig!
    try {
      await notifyOwner(
        { ownerId: String(application.buyerId), ownerType: "buyer" },
        {
          title: "🎉 Congratulations! You Won the Gig!",
          body: `You have been selected for the task: "${gig.title}". Open your Gigs dashboard to start work.`,
          url: `/hub`,
          tag: `gig_won_${gig._id}`,
          type: "system",
        },
      );
    } catch (notifErr) {
      console.warn("⚠️ Failed to notify buyer of gig win:", notifErr.message);
    }

    res.json({
      success: true,
      data: {
        message: "Gig successfully assigned to applicant! They have been notified to commence work.",
        gigStatus: "assigned",
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Vendor approves work and releases payout
 */
export async function approveGigWork(req, res, next) {
  try {
    const gig = await Gig.findById(req.params.id);
    if (!gig) throw new AppError("Gig not found.", 404);
    let vendorId = req.actor?.type === "vendor" ? req.actor.id : null;
    if (!vendorId && req.cookies?.auth_token) {
      try {
        const decoded = jwt.verify(req.cookies.auth_token, process.env.JWT_SECRET);
        if (decoded.userId && decoded.type !== "buyer") vendorId = decoded.userId;
      } catch {}
    }
    if (String(gig.vendorId) !== String(vendorId)) {
      throw new AppError("You can only approve work for your own gigs.", 403);
    }

    const application = await GigApplication.findOne({
      gigId: gig._id,
      status: "submitted",
    });

    if (!application) {
      throw new AppError("No submitted work pending approval for this gig.", 400);
    }

    application.status = "completed";
    application.payoutStatus = "released";
    application.payoutKobo = gig.rewardKobo;
    application.reviewedAt = new Date();
    await application.save();

    gig.status = "completed";
    await gig.save();

    // Grant bonus credit tokens to the buyer's account for task completion
    try {
      await Credits.findOneAndUpdate(
        { ownerId: application.buyerId, ownerType: "buyer" },
        {
          $inc: { balance: 100, totalEarned: 100 },
          $addToSet: { grants: `gig_completion:${gig._id}` },
        },
        { upsert: true, new: true },
      );
    } catch (creditErr) {
      console.warn("⚠️ Failed to grant completion credits:", creditErr.message);
    }

    // Notify Buyer of approval and earnings release
    try {
      const rewardNaira = Math.round((gig.rewardKobo || 0) / 100).toLocaleString();
      await notifyOwner(
        { ownerId: String(application.buyerId), ownerType: "buyer" },
        {
          title: "💰 Gig Approved & Payout Released!",
          body: `Your submission for "${gig.title}" was approved! ₦${rewardNaira} bounty has been credited to your account.`,
          url: `/hub`,
          tag: `gig_approved_${gig._id}`,
          type: "system",
        },
      );
    } catch (notifErr) {
      console.warn("⚠️ Failed to notify buyer of gig approval:", notifErr.message);
    }

    res.json({
      success: true,
      data: {
        message: "Work approved and payout released to the gig agent!",
        gigStatus: "completed",
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Vendor creates a new gig
 */
export async function createGig(req, res, next) {
  try {
    let vendorId = req.actor?.type === "vendor" ? req.actor.id : null;
    if (!vendorId && req.cookies?.auth_token) {
      try {
        const decoded = jwt.verify(req.cookies.auth_token, process.env.JWT_SECRET);
        if (decoded.userId && decoded.type !== "buyer") {
          const user = await User.findById(decoded.userId).select("_id").lean();
          if (user) vendorId = String(user._id);
        }
      } catch {}
    }

    if (!vendorId) {
      throw new AppError("Only vendors can post tasks and gigs.", 403);
    }

    const {
      title,
      description,
      category = "custom",
      workMode = "on-site",
      location = "Nigeria",
      rewardType = "instant",
      rewardKobo = 0,
      milestones = [],
      deadline = null,
      requiredSkills = [],
      imageUrl = null,
      images = [],
    } = req.body || {};

    if (!title || title.trim().length < 5) {
      throw new AppError("Gig title must be at least 5 characters.", 400);
    }
    if (!description || description.trim().length < 10) {
      throw new AppError("Gig description must be at least 10 characters.", 400);
    }
    if (rewardType === "instant" && (!rewardKobo || rewardKobo <= 0)) {
      throw new AppError("Please specify a valid reward amount.", 400);
    }

    const store = await Store.findOne({ vendorId }).select("_id").lean();

    const gig = await Gig.create({
      vendorId,
      storeId: store?._id || null,
      title: title.trim(),
      description: description.trim(),
      category,
      workMode,
      location: location.trim(),
      rewardType,
      rewardKobo: Number(rewardKobo),
      milestones,
      deadline: deadline ? new Date(deadline) : null,
      requiredSkills: Array.isArray(requiredSkills) ? requiredSkills : [],
      imageUrl: imageUrl || null,
      images: Array.isArray(images) ? images : [],
      status: "open",
    });

    res.status(201).json({
      success: true,
      data: {
        id: String(gig._id),
        message: "Gig published successfully! Premium buyers and agents can now apply.",
      },
    });
  } catch (err) {
    next(err);
  }
}

