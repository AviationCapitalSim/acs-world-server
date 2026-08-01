import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import flightRoutes from "./routes/flights.js";
import worldRoutes from "./routes/world.js";
import systemRoutes from "./routes/system.js";
import authRoutes from "./routes/auth.js";
import airlineRoutes from "./routes/airlines.js";
import hrRoutes, {
  startHRMoraleScheduler,
  stopHRMoraleScheduler
} from "./routes/hr.js";
import financeRoutes from "./routes/finance.js";
import bankRoutes from "./routes/bank.js";
import companySettingsRoutes from "./routes/company_settings.js";
import companyContextRoutes from "./routes/company_context.js";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import usersRoutes from "./routes/users.js";
import scheduleRoutes, {
  ACS_runMaintenanceResolver,
  stopMaintenanceScheduler
} from "./routes/schedule.js";
import aircraftRoutes, {
  ACS_runCDMaintenanceResolver
} from "./routes/aircraft.js";
import factoryRoutes from "./routes/factory.js";
import cabinPresetsRoutes from "./routes/cabin_presets.js";
import routePlanRoutes from "./routes/route_plans.js";
import myRoutesOccRoutes from "./routes/my_routes.js";
import airportsRoutes from "./routes/airports.js";
import skytrackRoutes from "./routes/skytrack.js";
import skytrackGlobalRoutes
  from "./routes/skytrack_global.js";
import skytrackSnapshotRoutes
  from "./routes/skytrack_snapshot.js";
import flightSettlementRoutes, {
  ACS_runFlightSettlementRuntime
} from "./routes/flight_settlement.js";
import occAlertsRoutes from "./routes/occ_alerts.js";
import {
  registerACSRuntimeJobHandler,
  startACSRuntimeSupervisor,
  stopACSRuntimeSupervisor
} from "./services/acs_runtime_supervisor.js";
import {
  ACS_generateFlightOccurrences,
  ACS_dispatchFlightOccurrences,
  ACS_advanceFlightOccurrences
} from "./services/acs_flight_runtime.js";
import {
  ACS_runAircraftDeliveryRuntime
} from "./services/acs_aircraft_delivery_runtime.js";
import {
  ACS_runFinanceMonthlyCloseRuntime
} from "./services/acs_finance_runtime.js";
import {
  ACS_runFactoryCapacityRuntime
} from "./services/acs_factory_capacity_runtime.js";

dotenv.config();

registerACSRuntimeJobHandler(
  "MAINTENANCE_AB",
  async () => {
    const result =
      await ACS_runMaintenanceResolver({
        allAirlines: true
      });

    if (Number(result?.error_count || 0) > 0) {
      const error = new Error(
        "MAINTENANCE_AB_PARTIAL_FAILURE"
      );

      error.code =
        "MAINTENANCE_AB_PARTIAL_FAILURE";

      throw error;
    }

    return {
      processedCount:
        Number(result?.started_count || 0) +
        Number(result?.completed_count || 0) +
        Number(result?.blocked_count || 0) +
        Number(
          result?.orphan_recovered_count || 0
        ) +
        Number(
          result?.phase0_normalized_count || 0
        )
    };
  }
);

registerACSRuntimeJobHandler(
  "MAINTENANCE_CD",
  async () => {
    const result =
      await ACS_runCDMaintenanceResolver({
        allAirlines: true
      });

    if (
      Number(result?.error_count || 0) > 0
    ) {
      const error = new Error(
        "MAINTENANCE_CD_PARTIAL_FAILURE"
      );

      error.code =
        "MAINTENANCE_CD_PARTIAL_FAILURE";

      throw error;
    }

    return {
      processedCount:
        Number(
          result?.completed_count || 0
        ) +
        Number(
          result?.cd_sync_count || 0
        ) +
        Number(
          result?.fleet_sync_count || 0
        )
    };
  }
);

registerACSRuntimeJobHandler(
  "FLIGHT_OCCURRENCES",
  async ({ job }) => {
    const result = await ACS_generateFlightOccurrences({
      horizonSimDays: job?.config?.horizon_sim_days || 8
    });

    return {
      processedCount: Number(result?.processedCount || 0)
    };
  }
);

registerACSRuntimeJobHandler(
  "FLIGHT_DISPATCH",
  async ({ job }) => {
    const batchSize =
      job?.config?.batch_size || 500;

    const dispatchResult =
  await ACS_dispatchFlightOccurrences({
    batchSize
  });

const lifecycleResult =
  await ACS_advanceFlightOccurrences({
    batchSize
  });

    return {
      processedCount:
        Number(
          lifecycleResult?.processedCount || 0
        ) +
        Number(
          dispatchResult?.processedCount || 0
        )
    };
  }
);

registerACSRuntimeJobHandler(
  "AIRCRAFT_DELIVERY",
  async ({ job }) => {
    const batchSize =
      Number(job?.config?.batch_size) || 100;

    const result =
      await ACS_runAircraftDeliveryRuntime({
        batchSize
      });

    return {
      processedCount:
        Number(result?.processedCount || 0)
    };
  }
);

registerACSRuntimeJobHandler(
  "FINANCE_MONTHLY_CLOSE",
  async () => {
    const result =
      await ACS_runFinanceMonthlyCloseRuntime();

    return {
      processedCount:
        Number(result?.processedCount || 0)
    };
  }
);

registerACSRuntimeJobHandler(
  "FACTORY_CAPACITY",
  async ({ job, simTime }) => {
    const result =
      await ACS_runFactoryCapacityRuntime({
        simTime,
        horizonYears:
          Number(job?.config?.horizon_years) || 10,
        minimumHorizonYear:
          Number(job?.config?.minimum_horizon_year) || 2035
      });

    return {
      processedCount:
        Number(result?.processedCount || 0)
    };
  }
);

registerACSRuntimeJobHandler(
  "FLIGHT_SETTLEMENT",
  async ({ job }) => {
    const batchSize =
      Number(job?.config?.batch_size) || 100;

    const result =
      await ACS_runFlightSettlementRuntime({
        batchSize
      });

    return {
      processedCount:
        Number(result?.processedCount || 0)
    };
  }
);

const app = express();

// 🔐 SECURITY HEADERS (HELMET)
app.use(helmet({
  contentSecurityPolicy: false // evitamos romper frontend por ahora
}));

// 🚦 GLOBAL RATE LIMIT (protección general)

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 300, // máximo 300 requests por IP
  standardHeaders: true,
  legacyHeaders: false
});

// 🔐 LOGIN RATE LIMIT (anti brute force)

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: "RATE_LIMIT",
    message: "Too many login attempts. Try again in 15 minutes."
  }
});

// 🔐 FORGOT PASSWORD RATE LIMIT

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: true,
    message: "If the account exists, a recovery email has been sent."
  }
});

// 🔐 RESET PASSWORD RATE LIMIT

const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    ok: false,
    error: "RATE_LIMIT",
    message: "Too many reset attempts. Try again later."
  }
});

app.set("trust proxy", 1);

const allowedOrigins = [
  "https://aviationcapitalsim.com",
  "https://www.aviationcapitalsim.com",
  "https://aviationcapitalsim.github.io"
];

const corsOptions = {
  origin: function(origin, callback) {

    // Permitir requests sin origin: curl, health checks, Railway checks
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error("CORS not allowed: " + origin));
  },
  credentials: true,
  methods: ["GET","POST","PATCH","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
};

/*
  CORS must run BEFORE rate limit.
  Otherwise 429 responses can appear in the browser as CORS failures.
*/
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

/*
  Global limiter after CORS.

  /v1/world is the ACS Time Authority endpoint.
  The frontend clock reads it frequently, so it must not be blocked
  by the general rate limiter.

  /health is also excluded so Railway can always verify the service.
*/
app.use((req, res, next) => {
  if (req.path === "/v1/world" || req.path === "/health") {
    return next();
  }

  return globalLimiter(req, res, next);
});

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// ✅ Health check (NO DB / NO ACS TIME AUTHORITY)
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "acs-world-server",
    authority: "RAILWAY_POSTGRESQL",
    time_engine: "POSTGRESQL_TIME_AUTHORITY"
  });
});

/* ============================================================
    ROUTES
   ============================================================ */

app.use("/v1", flightRoutes);
app.use("/v1", worldRoutes);
app.use("/v1", systemRoutes);
app.use("/v1/auth/login", loginLimiter);
app.use("/v1/auth/forgot-password", forgotPasswordLimiter);
app.use("/v1/auth/reset-password", resetPasswordLimiter);
app.use("/v1", authRoutes);
app.use("/v1", airlineRoutes);
app.use("/v1", hrRoutes);
app.use("/v1", companySettingsRoutes);
app.use("/v1", companyContextRoutes);
app.use("/v1", financeRoutes);
app.use("/v1", bankRoutes);
app.use("/v1", usersRoutes);
app.use("/v1", scheduleRoutes);
app.use("/v1", occAlertsRoutes);
app.use("/v1/skytrack", skytrackRoutes);
app.use("/v1/skytrack", skytrackGlobalRoutes);
app.use("/v1/skytrack", skytrackSnapshotRoutes);
app.use("/v1", aircraftRoutes);
app.use("/v1", cabinPresetsRoutes);
app.use("/v1", routePlanRoutes);
app.use("/v1", myRoutesOccRoutes);
app.use("/v1/aircraft/factory", factoryRoutes);
app.use("/v1", airportsRoutes);
app.use("/v1", flightSettlementRoutes);

const PORT = process.env.PORT || 3000;

// ✅ Logs básicos para detectar env vacíos
console.log("[ACS] Boot env:", {
  PORT,
  has_DATABASE_URL: !!process.env.DATABASE_URL,
  node_env: process.env.NODE_ENV || "undefined"
});

// ✅ Escuchar en 0.0.0.0 (Railway-friendly)
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("ACS World Server running on port", PORT);

  startHRMoraleScheduler();
  startACSRuntimeSupervisor();
});

/* ============================================================
    ACS GRACEFUL SHUTDOWN
   ------------------------------------------------------------
   - Stop the A/B maintenance scheduler first.
   - Then stop accepting new HTTP connections.
   - Railway SIGTERM/SIGINT safe.
   ============================================================ */

let ACS_shutdownStarted = false;

function ACS_shutdown(signal) {
  if (ACS_shutdownStarted) {
    return;
  }

  ACS_shutdownStarted = true;

  console.log(`[ACS] ${signal} received. Shutting down safely...`);

  stopMaintenanceScheduler();
  stopHRMoraleScheduler();
  stopACSRuntimeSupervisor();
  
  server.close(() => {
    console.log("[ACS] HTTP server closed");
    process.exit(0);
  });

  const forceExitTimer = setTimeout(() => {
    console.error("[ACS] Forced shutdown after timeout");
    process.exit(1);
  }, 10000);

  forceExitTimer.unref?.();
}

process.on("SIGTERM", () => {
  ACS_shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  ACS_shutdown("SIGINT");
});
