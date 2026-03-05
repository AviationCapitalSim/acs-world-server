import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import flightRoutes from "./routes/flights.js";

dotenv.config();

const app = express();

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ✅ Health check (NO DB) — Railway debe recibir respuesta sí o sí
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "acs-world-server",
    ts: Date.now()
  });
});

app.use("/v1", flightRoutes);

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
