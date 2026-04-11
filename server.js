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
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();

// 🔐 SECURITY HEADERS
app.use(helmet({
  contentSecurityPolicy: false
}));

// 🚦 GLOBAL RATE LIMIT
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
});

// 🔐 LOGIN RATE LIMIT
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    status: "RATE_LIMIT",
    message: "Too many login attempts. Try again in 15 minutes."
  }
});

app.use(globalLimiter);

app.set("trust proxy", 1);

// ✅ ORIGINS CENTRALIZADO
const allowedOrigins = [
  "https://aviationcapitalsim.com",
  "https://www.aviationcapitalsim.com",
  "https://aviationcapitalsim.github.io"
];

// ✅ CORS LIMPIO (SIN DUPLICADOS)
app.use(cors({
  origin: function(origin, callback) {

    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error("CORS not allowed: " + origin));
    }
  },
  credentials: true,
  methods: ["GET","POST","PATCH","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// ✅ Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "acs-world-server",
    ts: Date.now()
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
app.use("/v1", financeRoutes);

const PORT = process.env.PORT || 3000;

console.log("[ACS] Boot env:", {
  PORT,
  has_DATABASE_URL: !!process.env.DATABASE_URL,
  node_env: process.env.NODE_ENV || "undefined"
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("ACS World Server running on port", PORT);
});
