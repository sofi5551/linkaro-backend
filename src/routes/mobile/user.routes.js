const express = require("express");
const { verifyMobileToken } = require("../../middleware/mobileAuth");
const {
  me,
  listProviders,
  providerDetail,
  profileImage,
  subscription,
  updateBadgeSubscription,
  updateProfile,
  updateSubscription,
  verifyPassword,
  checkEmail,
  updateEmail,
  deactivateAccount,
} = require("../../controllers/mobile/user.controller");

const router = express.Router();

router.get("/me", verifyMobileToken, me);
router.get("/providers", verifyMobileToken, listProviders);
router.get("/provider/:id", verifyMobileToken, providerDetail);
// profile-image performs its own token verification (it cross-checks the `id` query param)
router.get("/profile-image", profileImage);
router.post("/subscription", verifyMobileToken, subscription);
router.post("/update-badge-subscription", verifyMobileToken, updateBadgeSubscription);
router.post("/update-profile", verifyMobileToken, updateProfile);
router.post("/update-subscription", verifyMobileToken, updateSubscription);
router.post("/verify-password", verifyMobileToken, verifyPassword);
router.post("/check-email", verifyMobileToken, checkEmail);
router.post("/update-email", verifyMobileToken, updateEmail);
router.post("/deactivate", verifyMobileToken, deactivateAccount);

module.exports = router;
