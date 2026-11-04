import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    authorId: { type: mongoose.Schema.Types.ObjectId, required: true },
    authorType: { type: String, enum: ["buyer", "vendor"], required: true },
    body: { type: String, required: true, maxlength: 500 },
    reported: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export default mongoose.model("CommunityPost", schema);
