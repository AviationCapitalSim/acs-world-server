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

app.use(globalLimiter);

app.set("trust proxy", 1);

const allowedOrigins = [
  "https://aviationcapitalsim.com",
  "https://www.aviationcapitalsim.com",
  "https://aviationcapitalsim.github.io"
];

app.use(cors({
  origin: function(origin, callback) {

    // permitir requests sin origin (ej: curl, health checks)
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

// ✅ Health check (NO DB) — Railway debe recibir respuesta sí o sí
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

// ✅ Logs básicos para detectar env vacíos
console.log("[ACS] Boot env:", {
  PORT,
  has_DATABASE_URL: !!process.env.DATABASE_URL,
  node_env: process.env.NODE_ENV || "undefined"
});

// ✅ Escuchar en 0.0.0.0 (Railway-friendly)
app.listen(PORT, "0.0.0.0", () => {
  console.log("ACS World Server running on port", PORT);
});
