import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import flightRoutes from "./routes/flights.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use("/v1", flightRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("ACS World Server running on port", PORT);
});
