import express from "express";

const router = express.Router();

/* ============================================================
   ACS OCC ALERTS
   ------------------------------------------------------------
   Runtime alerts only.
   No Railway table.
   No localStorage authority.
   ============================================================ */

router.get("/occ/alerts", async (req, res) => {
  try {
    return res.status(200).json({
      alerts: []
    });
  } catch (error) {
    console.error("[ACS OCC] alerts failed:", error);
    return res.status(500).json({
      alerts: [],
      error: "OCC_ALERTS_FAILED"
    });
  }
});

export default router;
