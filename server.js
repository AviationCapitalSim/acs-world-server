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

dotenv.config();

const app = express();

app.set("trust proxy", 1);

app.use(cors({
  origin: "*",
  methods: ["GET","POST","PATCH","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

app.options("*", cors());

app.use(express.json({ limit: "1mb" }));

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
