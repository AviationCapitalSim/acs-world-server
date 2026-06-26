import express from "express";

const router = express.Router();

/* ============================================================
   SKYTRACK CONTEXT
   PostgreSQL authority for SkyTrack runtime
   ============================================================ */

router.get("/context", async (req, res) => {

  try {

    const airlineId =
  req.user?.airline_id ||
  req.user?.airlineId ||
  req.airline_id ||
  req.airlineId ||
  req.session?.user?.airline_id ||
  req.session?.user?.airlineId ||
  req.session?.airline_id ||
  req.session?.airlineId ||
  req.query.airline_id ||
  req.query.airlineId;

    if (!airlineId) {
      return res.status(401).json({
        ok: false,
        error: "AIRLINE_SESSION_REQUIRED"
      });
    }

    /* ============================================================
       TEMPORAL RESPONSE
       (replace with PostgreSQL queries)
       ============================================================ */

    return res.json({
      ok: true,
      authority: "POSTGRESQL_SKYTRACK_AUTHORITY",
      airline_id: Number(airlineId),

      fleet: [],

      schedule_items: [],

      route_plans: [],

      generated_at: Date.now()
    });

  } catch (err) {

    console.error("SKYTRACK_CONTEXT_ERROR", err);

    return res.status(500).json({
      ok: false,
      error: "SKYTRACK_CONTEXT_ERROR"
    });

  }

});

export default router;
