import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import flightRoutes from "./routes/flights.js";
import worldRoutes from "./routes/world.js";
import systemRoutes from "./routes/system.js";
import authRoutes from "./routes/auth.js";
import airlineRoutes from "./routes/airlines.js";
import hrRoutes from "./routes/hr.js";
import financeRoutes from "./routes/finance.js";
import companySettingsRoutes from "./routes/company_settings.js";
import companyContextRoutes from "./routes/company_context.js";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import usersRoutes from "./routes/users.js";
import scheduleRoutes, {
  startMaintenanceScheduler,
  stopMaintenanceScheduler
} from "./routes/schedule.js";
import aircraftRoutes from "./routes/aircraft.js";
import factoryRoutes from "./routes/factory.js";
import routePlanRoutes from "./routes/route_plans.js";
import airportsRoutes from "./routes/airports.js";

dotenv.config();

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
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // máximo 10 intentos
  message: {
    status: "RATE_LIMIT",
    message: "Too many login attempts. Try again in 15 minutes."
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
app.use("/v1", authRoutes);
app.use("/v1", airlineRoutes);
app.use("/v1", hrRoutes);
app.use("/v1", companySettingsRoutes);
app.use("/v1", companyContextRoutes);
app.use("/v1", financeRoutes);
app.use("/v1", usersRoutes);
app.use("/v1", scheduleRoutes);
app.use("/v1", aircraftRoutes);
app.use("/v1", routePlanRoutes);
app.use("/v1/aircraft/factory", factoryRoutes);
app.use("/v1", airportsRoutes);

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

  startMaintenanceScheduler();
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
