/* ============================================================
   === ACS AIRCRAFT DATABASE — REQUIRED RUNWAY EDITION =========
   === Flat schema preserved — Ready for Buy/Lease Engine =====
   === Cleanup: duplicates and unbuilt projects removed ========
   === One added field only: required_runway_m =================
   ============================================================ */

const ACS_AIRCRAFT_DB = [

  // 1920s
  {
    manufacturer: "Junkers",
    model: "F.13",
    year: 1920,
    seats: 4,
    range_nm: 430,
    speed_kts: 95,
    mtow_kg: 1950,
    fuel_burn_kgph: 90,
    price_acs_usd: 60000,
    engines: "BMW IIIa",
    required_runway_m: 700
  },
  {
    manufacturer: "Fokker",
    model: "F.VIIb-3m",
    year: 1924,
    seats: 8,
    range_nm: 750,
    speed_kts: 105,
    mtow_kg: 5200,
    fuel_burn_kgph: 220,
    price_acs_usd: 120000,
    engines: "Wright J-4 / J-5",
    required_runway_m: 900
  },
  {
    manufacturer: "Ford",
    model: "5-AT Trimotor",
    year: 1926,
    seats: 10,
    range_nm: 510,
    speed_kts: 105,
    mtow_kg: 6350,
    fuel_burn_kgph: 260,
    price_acs_usd: 150000,
    engines: "PW Wasp",
    required_runway_m: 950
  },
  {
    manufacturer: "Lockheed",
    model: "Vega 5",
    year: 1927,
    seats: 6,
    range_nm: 725,
    speed_kts: 140,
    mtow_kg: 2500,
    fuel_burn_kgph: 200,
    price_acs_usd: 95000,
    engines: "PW Wasp",
    required_runway_m: 750
  },

  // 1930s
  {
    manufacturer: "Lockheed",
    model: "Model 9 Orion",
    year: 1931,
    seats: 6,
    range_nm: 750,
    speed_kts: 160,
    mtow_kg: 3800,
    fuel_burn_kgph: 230,
    price_acs_usd: 140000,
    engines: "PW Wasp",
    required_runway_m: 850
  },
  {
    manufacturer: "de Havilland",
    model: "DH.84 Dragon",
    year: 1932,
    seats: 6,
    range_nm: 500,
    speed_kts: 105,
    mtow_kg: 2000,
    fuel_burn_kgph: 150,
    price_acs_usd: 80000,
    engines: "DH Gipsy Major",
    required_runway_m: 700
  },
  {
    manufacturer: "Boeing",
    model: "247",
    year: 1933,
    seats: 10,
    range_nm: 745,
    speed_kts: 160,
    mtow_kg: 8800,
    fuel_burn_kgph: 360,
    price_acs_usd: 280000,
    engines: "PW R-1340",
    required_runway_m: 1050
  },
  {
    manufacturer: "de Havilland",
    model: "DH.89 Dragon Rapide",
    year: 1934,
    seats: 8,
    range_nm: 500,
    speed_kts: 115,
    mtow_kg: 2700,
    fuel_burn_kgph: 160,
    price_acs_usd: 90000,
    engines: "DH Gipsy Six",
    required_runway_m: 750
  },

  // 1940s
  {
    manufacturer: "Convair",
    model: "CV-240",
    year: 1947,
    seats: 40,
    range_nm: 1150,
    speed_kts: 255,
    mtow_kg: 16500,
    fuel_burn_kgph: 750,
    price_acs_usd: 1200000,
    engines: "PW R-2800",
    required_runway_m: 1250
  },

  // 1950s
  {
    manufacturer: "Convair",
    model: "CV-340",
    year: 1951,
    seats: 44,
    range_nm: 1600,
    speed_kts: 270,
    mtow_kg: 20000,
    fuel_burn_kgph: 850,
    price_acs_usd: 1500000,
    engines: "PW R-2800",
    required_runway_m: 1350
  },
  {
    manufacturer: "Convair",
    model: "CV-440 Metropolitan",
    year: 1956,
    seats: 52,
    range_nm: 2100,
    speed_kts: 280,
    mtow_kg: 20700,
    fuel_burn_kgph: 900,
    price_acs_usd: 1800000,
    engines: "PW R-2800",
    required_runway_m: 1350
  },

  // 1940s
  {
    manufacturer: "Vickers",
    model: "VC.1 Viking",
    year: 1946,
    seats: 27,
    range_nm: 1000,
    speed_kts: 220,
    mtow_kg: 18500,
    fuel_burn_kgph: 650,
    price_acs_usd: 950000,
    engines: "Bristol Hercules",
    required_runway_m: 1300
  },

  // 1930s
  {
    manufacturer: "de Havilland",
    model: "DH.95 Flamingo",
    year: 1938,
    seats: 12,
    range_nm: 850,
    speed_kts: 190,
    mtow_kg: 6400,
    fuel_burn_kgph: 380,
    price_acs_usd: 600000,
    engines: "Bristol Perseus",
    required_runway_m: 950
  },

  // 1940s
  {
    manufacturer: "Avro",
    model: "Lancastrian",
    year: 1943,
    seats: 13,
    range_nm: 4300,
    speed_kts: 280,
    mtow_kg: 33000,
    fuel_burn_kgph: 1600,
    price_acs_usd: 1800000,
    engines: "RR Merlin",
    required_runway_m: 1600
  },
  {
    manufacturer: "Boeing",
    model: "C-97 Stratofreighter",
    year: 1944,
    seats: 80,
    range_nm: 3500,
    speed_kts: 310,
    mtow_kg: 66000,
    fuel_burn_kgph: 2600,
    price_acs_usd: 3500000,
    engines: "PW R-4360",
    required_runway_m: 2050
  },
  {
    manufacturer: "Lockheed",
    model: "Model 18-56 Lodestar (Military C-60)",
    year: 1942,
    seats: 18,
    range_nm: 1500,
    speed_kts: 245,
    mtow_kg: 8200,
    fuel_burn_kgph: 580,
    price_acs_usd: 700000,
    engines: "PW R-1830",
    required_runway_m: 1000
  },
  {
    manufacturer: "Handley Page",
    model: "HP.70 Halton",
    year: 1946,
    seats: 34,
    range_nm: 1540,
    speed_kts: 240,
    mtow_kg: 31000,
    fuel_burn_kgph: 1400,
    price_acs_usd: 1300000,
    engines: "Bristol Hercules",
    required_runway_m: 1600
  },
  {
    manufacturer: "Curtiss",
    model: "C-46 Commando",
    year: 1941,
    seats: 40,
    range_nm: 2000,
    speed_kts: 270,
    mtow_kg: 20400,
    fuel_burn_kgph: 1200,
    price_acs_usd: 1700000,
    engines: "Wright R-2800",
    required_runway_m: 1350
  },

  // 1930s
  {
    manufacturer: "de Havilland",
    model: "DH.86 Express",
    year: 1934,
    seats: 10,
    range_nm: 640,
    speed_kts: 140,
    mtow_kg: 3900,
    fuel_burn_kgph: 240,
    price_acs_usd: 110000,
    engines: "DH Gipsy Six (x4)",
    required_runway_m: 850
  },
  {
    manufacturer: "de Havilland",
    model: "DH.91 Albatross",
    year: 1938,
    seats: 22,
    range_nm: 1900,
    speed_kts: 210,
    mtow_kg: 15500,
    fuel_burn_kgph: 850,
    price_acs_usd: 600000,
    engines: "RR Gipsy Twelve",
    required_runway_m: 1250
  },

  // 1940s
  {
    manufacturer: "de Havilland",
    model: "DH.104 Dove",
    year: 1946,
    seats: 8,
    range_nm: 850,
    speed_kts: 210,
    mtow_kg: 3650,
    fuel_burn_kgph: 300,
    price_acs_usd: 450000,
    engines: "Gipsy Queen 70-3",
    required_runway_m: 850
  },

  // 1950s
  {
    manufacturer: "de Havilland",
    model: "DH.114 Heron",
    year: 1950,
    seats: 17,
    range_nm: 870,
    speed_kts: 175,
    mtow_kg: 6350,
    fuel_burn_kgph: 360,
    price_acs_usd: 850000,
    engines: "Gipsy Queen 30 (x4)",
    required_runway_m: 950
  },
  {
    manufacturer: "de Havilland",
    model: "Comet 1",
    year: 1952,
    seats: 36,
    range_nm: 1500,
    speed_kts: 430,
    mtow_kg: 48000,
    fuel_burn_kgph: 5000,
    price_acs_usd: 5000000,
    engines: "Ghost 50 Mk1",
    required_runway_m: 2400
  },
  {
    manufacturer: "de Havilland",
    model: "Comet 2",
    year: 1953,
    seats: 44,
    range_nm: 2100,
    speed_kts: 440,
    mtow_kg: 54000,
    fuel_burn_kgph: 5200,
    price_acs_usd: 6200000,
    engines: "Ghost 50 Mk2",
    required_runway_m: 2450
  },
  {
    manufacturer: "de Havilland",
    model: "Comet 3",
    year: 1954,
    seats: 58,
    range_nm: 2600,
    speed_kts: 455,
    mtow_kg: 72000,
    fuel_burn_kgph: 5600,
    price_acs_usd: 7000000,
    engines: "Ghost 50 Mk4",
    required_runway_m: 2750
  },
  {
    manufacturer: "de Havilland",
    model: "Comet 4",
    year: 1958,
    seats: 81,
    range_nm: 3100,
    speed_kts: 455,
    mtow_kg: 73000,
    fuel_burn_kgph: 5800,
    price_acs_usd: 9500000,
    engines: "Ghost 50 Mk4B",
    required_runway_m: 2750
  },

  // 1960s
  {
    manufacturer: "Hawker Siddeley",
    model: "Trident 1C",
    year: 1964,
    seats: 117,
    range_nm: 2000,
    speed_kts: 530,
    mtow_kg: 60000,
    fuel_burn_kgph: 5900,
    price_acs_usd: 12000000,
    engines: "RR Spey 505",
    required_runway_m: 2000
  },
  {
    manufacturer: "Hawker Siddeley",
    model: "Trident 2E",
    year: 1968,
    seats: 128,
    range_nm: 2500,
    speed_kts: 530,
    mtow_kg: 66000,
    fuel_burn_kgph: 6200,
    price_acs_usd: 13500000,
    engines: "RR Spey 512",
    required_runway_m: 2050
  },

  // 1970s
  {
    manufacturer: "Hawker Siddeley",
    model: "Trident 3B",
    year: 1971,
    seats: 180,
    range_nm: 1750,
    speed_kts: 530,
    mtow_kg: 70000,
    fuel_burn_kgph: 6500,
    price_acs_usd: 15000000,
    engines: "RR Spey 555-15",
    required_runway_m: 2100
  },

  // 1950s
  {
    manufacturer: "Vickers",
    model: "Viscount 700",
    year: 1953,
    seats: 48,
    range_nm: 1400,
    speed_kts: 280,
    mtow_kg: 31000,
    fuel_burn_kgph: 1450,
    price_acs_usd: 4200000,
    engines: "RR Dart",
    required_runway_m: 1350
  },
  {
    manufacturer: "Vickers",
    model: "Viscount 800",
    year: 1957,
    seats: 65,
    range_nm: 1550,
    speed_kts: 295,
    mtow_kg: 35000,
    fuel_burn_kgph: 1550,
    price_acs_usd: 5400000,
    engines: "RR Dart",
    required_runway_m: 1400
  },
  {
    manufacturer: "Vickers",
    model: "Viscount 810",
    year: 1959,
    seats: 78,
    range_nm: 1650,
    speed_kts: 300,
    mtow_kg: 39000,
    fuel_burn_kgph: 1650,
    price_acs_usd: 6800000,
    engines: "RR Dart",
    required_runway_m: 1450
  },
  {
    manufacturer: "Vickers",
    model: "Vanguard V.953",
    year: 1959,
    seats: 132,
    range_nm: 1800,
    speed_kts: 330,
    mtow_kg: 60000,
    fuel_burn_kgph: 3000,
    price_acs_usd: 15000000,
    engines: "RR Tyne",
    required_runway_m: 1650
  },

  // 1960s
  {
    manufacturer: "Vickers",
    model: "Vanguard V.952 (Cargo Merchantman)",
    year: 1963,
    seats: 0,
    range_nm: 1800,
    speed_kts: 330,
    mtow_kg: 60000,
    fuel_burn_kgph: 3100,
    price_acs_usd: 17000000,
    engines: "RR Tyne",
    status: "cargo",
    required_runway_m: 1650
  },

  // 1950s
  {
    manufacturer: "Bristol",
    model: "Britannia 100",
    year: 1952,
    seats: 90,
    range_nm: 3950,
    speed_kts: 330,
    mtow_kg: 57000,
    fuel_burn_kgph: 3000,
    price_acs_usd: 16000000,
    engines: "Proteus 625",
    required_runway_m: 1650
  },
  {
    manufacturer: "Bristol",
    model: "Britannia 300",
    year: 1958,
    seats: 139,
    range_nm: 4300,
    speed_kts: 350,
    mtow_kg: 74000,
    fuel_burn_kgph: 3400,
    price_acs_usd: 21000000,
    engines: "Proteus 755",
    required_runway_m: 1800
  },
  {
    manufacturer: "Handley Page",
    model: "HP.81 Hermes",
    year: 1950,
    seats: 40,
    range_nm: 2300,
    speed_kts: 240,
    mtow_kg: 30000,
    fuel_burn_kgph: 1600,
    price_acs_usd: 5500000,
    engines: "Bristol Hercules",
    required_runway_m: 1500
  },

  // 1960s
  {
    manufacturer: "Handley Page",
    model: "HP.137 Jetstream",
    year: 1967,
    seats: 18,
    range_nm: 950,
    speed_kts: 265,
    mtow_kg: 5700,
    fuel_burn_kgph: 450,
    price_acs_usd: 3000000,
    engines: "Astazou XIV",
    required_runway_m: 900
  },
  {
    manufacturer: "Fokker",
    model: "Fokker F27-500",
    year: 1968,
    seats: 56,
    range_nm: 1400,
    speed_kts: 265,
    mtow_kg: 20000,
    fuel_burn_kgph: 950,
    price_acs_usd: 4900000,
    engines: "RR Dart",
    required_runway_m: 1150
  },

  // 1950s
  {
    manufacturer: "Ilyushin",
    model: "Il-18A",
    year: 1958,
    seats: 75,
    range_nm: 2200,
    speed_kts: 335,
    mtow_kg: 64000,
    fuel_burn_kgph: 3200,
    price_acs_usd: 12000000,
    engines: "Ivchenko AI-20",
    required_runway_m: 1700
  },

  // 1960s
  {
    manufacturer: "Ilyushin",
    model: "Il-18D",
    year: 1965,
    seats: 120,
    range_nm: 3900,
    speed_kts: 350,
    mtow_kg: 64000,
    fuel_burn_kgph: 3400,
    price_acs_usd: 14500000,
    engines: "Ivchenko AI-20M",
    required_runway_m: 1700
  },

  // 1930s
  {
    manufacturer: "Douglas",
    model: "DC-1",
    year: 1933,
    seats: 12,
    range_nm: 1000,
    speed_kts: 190,
    mtow_kg: 7050,
    fuel_burn_kgph: 420,
    price_acs_usd: 480000,
    engines: "PW R-1690",
    required_runway_m: 1000
  },

  // 1950s
  {
    manufacturer: "Douglas",
    model: "DC-6B",
    year: 1951,
    seats: 68,
    range_nm: 4025,
    speed_kts: 310,
    mtow_kg: 49250,
    fuel_burn_kgph: 2400,
    price_acs_usd: 3650000,
    engines: "PW R-2800",
    required_runway_m: 1800
  },
  {
    manufacturer: "Douglas",
    model: "DC-7B",
    year: 1954,
    seats: 79,
    range_nm: 4300,
    speed_kts: 335,
    mtow_kg: 65000,
    fuel_burn_kgph: 3100,
    price_acs_usd: 5200000,
    engines: "Wright R-3350",
    required_runway_m: 2050
  },
  {
    manufacturer: "Douglas",
    model: "DC-7C Seven Seas",
    year: 1956,
    seats: 90,
    range_nm: 5150,
    speed_kts: 350,
    mtow_kg: 68000,
    fuel_burn_kgph: 3300,
    price_acs_usd: 5900000,
    engines: "Wright R-3350",
    required_runway_m: 2100
  },

  // 1940s
  {
    manufacturer: "Boeing",
    model: "377 Stratocruiser",
    year: 1947,
    seats: 100,
    range_nm: 4350,
    speed_kts: 300,
    mtow_kg: 61000,
    fuel_burn_kgph: 2350,
    price_acs_usd: 4300000,
    engines: "PW R-4360",
    required_runway_m: 2000
  },

  // 1960s
  {
    manufacturer: "Boeing",
    model: "720",
    year: 1960,
    seats: 116,
    range_nm: 2800,
    speed_kts: 540,
    mtow_kg: 104000,
    fuel_burn_kgph: 6100,
    price_acs_usd: 13500000,
    engines: "JT3C / JT3D",
    required_runway_m: 3050
  },
  {
    manufacturer: "Boeing",
    model: "727-200",
    year: 1967,
    seats: 155,
    range_nm: 2050,
    speed_kts: 540,
    mtow_kg: 86000,
    fuel_burn_kgph: 5500,
    price_acs_usd: 16000000,
    engines: "JT8D-15",
    required_runway_m: 2250
  },

  // 1990s
  {
    manufacturer: "Boeing",
    model: "737-500",
    year: 1990,
    seats: 108,
    range_nm: 2200,
    speed_kts: 495,
    mtow_kg: 60500,
    fuel_burn_kgph: 3000,
    price_acs_usd: 23000000,
    engines: "CFM56-3C1",
    required_runway_m: 1750
  },

  // 1980s
  {
    manufacturer: "Boeing",
    model: "747-300",
    year: 1983,
    seats: 412,
    range_nm: 6000,
    speed_kts: 560,
    mtow_kg: 351000,
    fuel_burn_kgph: 24000,
    price_acs_usd: 165000000,
    engines: "JT9D-7R4G2",
    required_runway_m: 3550
  },

  // 1970s
  {
    manufacturer: "Boeing",
    model: "747SP",
    year: 1976,
    seats: 276,
    range_nm: 6650,
    speed_kts: 560,
    mtow_kg: 314000,
    fuel_burn_kgph: 22000,
    price_acs_usd: 155000000,
    engines: "JT9D-7A",
    required_runway_m: 3350
  },

  // 1990s
  {
    manufacturer: "Boeing",
    model: "777-200ER",
    year: 1997,
    seats: 314,
    range_nm: 7250,
    speed_kts: 560,
    mtow_kg: 297500,
    fuel_burn_kgph: 9000,
    price_acs_usd: 208000000,
    engines: "GE90-94B",
    required_runway_m: 3100
  },

  // 2000s
  {
    manufacturer: "Boeing",
    model: "777-200LR",
    year: 2006,
    seats: 317,
    range_nm: 9400,
    speed_kts: 560,
    mtow_kg: 347800,
    fuel_burn_kgph: 9500,
    price_acs_usd: 250000000,
    engines: "GE90-110B/115B",
    required_runway_m: 3100
  },

  // 1950s
  {
    manufacturer: "McDonnell Douglas",
    model: "DC-8-20",
    year: 1959,
    seats: 125,
    range_nm: 3100,
    speed_kts: 540,
    mtow_kg: 124000,
    fuel_burn_kgph: 7200,
    price_acs_usd: 16000000,
    engines: "JT4A",
    required_runway_m: 3250
  },

  // 1960s
  {
    manufacturer: "McDonnell Douglas",
    model: "DC-8-30",
    year: 1960,
    seats: 142,
    range_nm: 3800,
    speed_kts: 545,
    mtow_kg: 143000,
    fuel_burn_kgph: 7500,
    price_acs_usd: 17500000,
    engines: "JT4A",
    required_runway_m: 3450
  },
  {
    manufacturer: "McDonnell Douglas",
    model: "DC-8-40",
    year: 1961,
    seats: 146,
    range_nm: 4050,
    speed_kts: 550,
    mtow_kg: 147000,
    fuel_burn_kgph: 7000,
    price_acs_usd: 18000000,
    engines: "RR Conway 509",
    required_runway_m: 3450
  },
  {
    manufacturer: "McDonnell Douglas",
    model: "DC-8-61",
    year: 1965,
    seats: 259,
    range_nm: 3300,
    speed_kts: 550,
    mtow_kg: 162000,
    fuel_burn_kgph: 8500,
    price_acs_usd: 19500000,
    engines: "JT3D",
    required_runway_m: 3550
  },
  {
    manufacturer: "McDonnell Douglas",
    model: "DC-8-62",
    year: 1967,
    seats: 189,
    range_nm: 5100,
    speed_kts: 550,
    mtow_kg: 158000,
    fuel_burn_kgph: 8200,
    price_acs_usd: 20500000,
    engines: "JT3D",
    required_runway_m: 3550
  },
  {
    manufacturer: "McDonnell Douglas",
    model: "DC-8-63",
    year: 1968,
    seats: 259,
    range_nm: 4600,
    speed_kts: 550,
    mtow_kg: 162000,
    fuel_burn_kgph: 8500,
    price_acs_usd: 21000000,
    engines: "JT3D",
    required_runway_m: 3550
  },

  // 1980s
  {
    manufacturer: "McDonnell Douglas",
    model: "DC-8-71",
    year: 1982,
    seats: 259,
    range_nm: 3800,
    speed_kts: 550,
    mtow_kg: 165000,
    fuel_burn_kgph: 6500,
    price_acs_usd: 23000000,
    engines: "CFM56-2",
    required_runway_m: 2600
  },
  {
    manufacturer: "McDonnell Douglas",
    model: "DC-8-72",
    year: 1982,
    seats: 189,
    range_nm: 5200,
    speed_kts: 550,
    mtow_kg: 165000,
    fuel_burn_kgph: 6400,
    price_acs_usd: 24000000,
    engines: "CFM56-2",
    required_runway_m: 2600
  },
  {
    manufacturer: "McDonnell Douglas",
    model: "DC-8-73",
    year: 1982,
    seats: 259,
    range_nm: 4600,
    speed_kts: 550,
    mtow_kg: 165000,
    fuel_burn_kgph: 6450,
    price_acs_usd: 24500000,
    engines: "CFM56-2",
    required_runway_m: 2600
  },

  // 1960s
  {
    manufacturer: "McDonnell Douglas",
    model: "DC-9-10",
    year: 1965,
    seats: 90,
    range_nm: 1400,
    speed_kts: 485,
    mtow_kg: 38000,
    fuel_burn_kgph: 2600,
    price_acs_usd: 12000000,
    engines: "JT8D-1",
    required_runway_m: 1700
  },
  {
    manufacturer: "McDonnell Douglas",
    model: "DC-9-20",
    year: 1969,
    seats: 95,
    range_nm: 1500,
    speed_kts: 485,
    mtow_kg: 39500,
    fuel_burn_kgph: 2700,
    price_acs_usd: 13000000,
    engines: "JT8D-11",
    required_runway_m: 1700
  },
  {
    manufacturer: "McDonnell Douglas",
    model: "DC-9-30",
    year: 1967,
    seats: 115,
    range_nm: 1550,
    speed_kts: 490,
    mtow_kg: 47000,
    fuel_burn_kgph: 2900,
    price_acs_usd: 14000000,
    engines: "JT8D-7",
    required_runway_m: 1800
  },
  {
    manufacturer: "McDonnell Douglas",
    model: "DC-9-40",
    year: 1968,
    seats: 125,
    range_nm: 1500,
    speed_kts: 490,
    mtow_kg: 49500,
    fuel_burn_kgph: 3000,
    price_acs_usd: 15000000,
    engines: "JT8D-9",
    required_runway_m: 1850
  },

  // 1970s
  {
    manufacturer: "McDonnell Douglas",
    model: "DC-9-50",
    year: 1975,
    seats: 139,
    range_nm: 1600,
    speed_kts: 490,
    mtow_kg: 54000,
    fuel_burn_kgph: 3150,
    price_acs_usd: 16500000,
    engines: "JT8D-17",
    required_runway_m: 1700
  },

  // 1980s
  {
    manufacturer: "McDonnell Douglas",
    model: "MD-81",
    year: 1980,
    seats: 155,
    range_nm: 1500,
    speed_kts: 475,
    mtow_kg: 63500,
    fuel_burn_kgph: 3500,
    price_acs_usd: 21000000,
    engines: "JT8D-209",
    required_runway_m: 2300
  },
  {
    manufacturer: "McDonnell Douglas",
    model: "MD-83",
    year: 1985,
    seats: 155,
    range_nm: 2400,
    speed_kts: 475,
    mtow_kg: 70800,
    fuel_burn_kgph: 3600,
    price_acs_usd: 22500000,
    engines: "JT8D-219",
    required_runway_m: 1850
  },
  {
    manufacturer: "McDonnell Douglas",
    model: "MD-87",
    year: 1987,
    seats: 130,
    range_nm: 2500,
    speed_kts: 475,
    mtow_kg: 62500,
    fuel_burn_kgph: 3300,
    price_acs_usd: 23000000,
    engines: "JT8D-217",
    required_runway_m: 1800
  },
  {
    manufacturer: "McDonnell Douglas",
    model: "MD-88",
    year: 1988,
    seats: 155,
    range_nm: 2200,
    speed_kts: 475,
    mtow_kg: 67500,
    fuel_burn_kgph: 3500,
    price_acs_usd: 24000000,
    engines: "JT8D-219",
    required_runway_m: 1850
  },

  // 1990s
  {
    manufacturer: "McDonnell Douglas",
    model: "MD-90",
    year: 1993,
    seats: 172,
    range_nm: 2100,
    speed_kts: 475,
    mtow_kg: 76000,
    fuel_burn_kgph: 3100,
    price_acs_usd: 26000000,
    engines: "IAE V2500",
    required_runway_m: 1900
  },
  {
    manufacturer: "Boeing",
    model: "717-200",
    year: 1999,
    seats: 117,
    range_nm: 2060,
    speed_kts: 470,
    mtow_kg: 55000,
    fuel_burn_kgph: 2600,
    price_acs_usd: 30000000,
    engines: "RR BR715",
    required_runway_m: 1700
  },

  // 1970s
  {
    manufacturer: "Airbus",
    model: "A300B1",
    year: 1972,
    seats: 259,
    range_nm: 1150,
    speed_kts: 495,
    mtow_kg: 132000,
    fuel_burn_kgph: 5200,
    price_acs_usd: 42000000,
    engines: "GE CF6-50A",
    required_runway_m: 2650
  },
  {
    manufacturer: "Airbus",
    model: "A300B2-200",
    year: 1976,
    seats: 266,
    range_nm: 1900,
    speed_kts: 495,
    mtow_kg: 142000,
    fuel_burn_kgph: 5400,
    price_acs_usd: 54000000,
    engines: "GE CF6-50C",
    required_runway_m: 2500
  },
  {
    manufacturer: "Airbus",
    model: "A300B4-200",
    year: 1979,
    seats: 266,
    range_nm: 2600,
    speed_kts: 495,
    mtow_kg: 157000,
    fuel_burn_kgph: 5600,
    price_acs_usd: 62000000,
    engines: "GE CF6-50C2",
    required_runway_m: 2550
  },

  // 2000s
  {
    manufacturer: "Airbus",
    model: "A318-100",
    year: 2003,
    seats: 117,
    range_nm: 3100,
    speed_kts: 470,
    mtow_kg: 68000,
    fuel_burn_kgph: 2500,
    price_acs_usd: 72000000,
    engines: "CFM56-5B8",
    required_runway_m: 1850
  },

  // 2010s
  {
    manufacturer: "Airbus",
    model: "A319neo",
    year: 2017,
    seats: 140,
    range_nm: 3500,
    speed_kts: 470,
    mtow_kg: 75000,
    fuel_burn_kgph: 2400,
    price_acs_usd: 99000000,
    engines: "LEAP-1A26",
    required_runway_m: 1900
  },

  // 1990s
  {
    manufacturer: "Airbus",
    model: "A340-200",
    year: 1992,
    seats: 261,
    range_nm: 7400,
    speed_kts: 490,
    mtow_kg: 253000,
    fuel_burn_kgph: 7400,
    price_acs_usd: 170000000,
    engines: "CFM56-5C",
    required_runway_m: 3350
  },
  {
    manufacturer: "Airbus",
    model: "A340-300",
    year: 1993,
    seats: 295,
    range_nm: 7000,
    speed_kts: 490,
    mtow_kg: 257000,
    fuel_burn_kgph: 7800,
    price_acs_usd: 180000000,
    engines: "CFM56-5C",
    required_runway_m: 3350
  },

  // 1980s
  {
    manufacturer: "De Havilland Canada",
    model: "Dash 8-100",
    year: 1984,
    seats: 37,
    range_nm: 1200,
    speed_kts: 285,
    mtow_kg: 15600,
    fuel_burn_kgph: 700,
    price_acs_usd: 12500000,
    engines: "PW120A",
    required_runway_m: 1100
  },

  // 1990s
  {
    manufacturer: "De Havilland Canada",
    model: "Dash 8-200",
    year: 1995,
    seats: 39,
    range_nm: 1250,
    speed_kts: 285,
    mtow_kg: 17000,
    fuel_burn_kgph: 750,
    price_acs_usd: 14500000,
    engines: "PW123C",
    required_runway_m: 1100
  },

  // 1980s
  {
    manufacturer: "De Havilland Canada",
    model: "Dash 8-300",
    year: 1989,
    seats: 56,
    range_nm: 930,
    speed_kts: 285,
    mtow_kg: 19000,
    fuel_burn_kgph: 900,
    price_acs_usd: 18500000,
    engines: "PW123",
    required_runway_m: 1150
  },

  // 2000s
  {
    manufacturer: "Bombardier",
    model: "CRJ440",
    year: 2001,
    seats: 44,
    range_nm: 1400,
    speed_kts: 450,
    mtow_kg: 22700,
    fuel_burn_kgph: 1600,
    price_acs_usd: 25500000,
    engines: "GE CF34-3B1",
    required_runway_m: 1300
  },

  // 2010s
  {
    manufacturer: "Bombardier",
    model: "CRJ1000",
    year: 2010,
    seats: 104,
    range_nm: 1600,
    speed_kts: 470,
    mtow_kg: 41800,
    fuel_burn_kgph: 2300,
    price_acs_usd: 46000000,
    engines: "GE CF34-8C5A1",
    required_runway_m: 1600
  },

  // 1990s
  {
    manufacturer: "Embraer",
    model: "ERJ-140",
    year: 1997,
    seats: 44,
    range_nm: 1650,
    speed_kts: 430,
    mtow_kg: 20900,
    fuel_burn_kgph: 1550,
    price_acs_usd: 22500000,
    engines: "RR AE3007A1",
    required_runway_m: 1250
  },

  // 2000s
  {
    manufacturer: "Embraer",
    model: "E175",
    year: 2003,
    seats: 78,
    range_nm: 1800,
    speed_kts: 470,
    mtow_kg: 36000,
    fuel_burn_kgph: 2400,
    price_acs_usd: 38000000,
    engines: "GE CF34-8E",
    required_runway_m: 1450
  },
  {
    manufacturer: "Embraer",
    model: "E195",
    year: 2006,
    seats: 122,
    range_nm: 2300,
    speed_kts: 470,
    mtow_kg: 50400,
    fuel_burn_kgph: 2600,
    price_acs_usd: 44000000,
    engines: "GE CF34-10E",
    required_runway_m: 1650
  },

  // 1980s
  {
    manufacturer: "Fokker",
    model: "F50",
    year: 1985,
    seats: 52,
    range_nm: 1480,
    speed_kts: 285,
    mtow_kg: 20500,
    fuel_burn_kgph: 950,
    price_acs_usd: 8000000,
    engines: "PW125B",
    required_runway_m: 1150
  },

  // 1960s
  {
    manufacturer: "Hawker Siddeley",
    model: "HS-121 Trident 1C",
    year: 1962,
    seats: 101,
    range_nm: 1500,
    speed_kts: 525,
    mtow_kg: 52800,
    fuel_burn_kgph: 4800,
    price_acs_usd: 9000000,
    engines: "RR Spey",
    required_runway_m: 1850
  },
  {
    manufacturer: "Hawker Siddeley",
    model: "HS-121 Trident 2E",
    year: 1968,
    seats: 115,
    range_nm: 2050,
    speed_kts: 525,
    mtow_kg: 56500,
    fuel_burn_kgph: 5100,
    price_acs_usd: 10500000,
    engines: "RR Spey",
    required_runway_m: 1900
  },

  // 1970s
  {
    manufacturer: "Hawker Siddeley",
    model: "HS-121 Trident 3B",
    year: 1971,
    seats: 180,
    range_nm: 1750,
    speed_kts: 525,
    mtow_kg: 64000,
    fuel_burn_kgph: 5400,
    price_acs_usd: 12000000,
    engines: "RR Spey + Booster",
    required_runway_m: 2050
  },

  // 1980s
  {
    manufacturer: "BAe",
    model: "BAe 146-100",
    year: 1983,
    seats: 82,
    range_nm: 1050,
    speed_kts: 430,
    mtow_kg: 38100,
    fuel_burn_kgph: 3000,
    price_acs_usd: 24000000,
    engines: "Lycoming ALF 502R-5",
    required_runway_m: 1500
  },
  {
    manufacturer: "BAe",
    model: "BAe 146-200",
    year: 1982,
    seats: 100,
    range_nm: 1600,
    speed_kts: 430,
    mtow_kg: 42100,
    fuel_burn_kgph: 3200,
    price_acs_usd: 26000000,
    engines: "Lycoming ALF 502R-5",
    required_runway_m: 1600
  },
  {
    manufacturer: "BAe",
    model: "BAe 146-300",
    year: 1988,
    seats: 112,
    range_nm: 1600,
    speed_kts: 430,
    mtow_kg: 43800,
    fuel_burn_kgph: 3400,
    price_acs_usd: 28000000,
    engines: "Lycoming ALF 502R-5",
    required_runway_m: 1600
  },

  // 1990s
  {
    manufacturer: "Avro",
    model: "RJ70",
    year: 1992,
    seats: 70,
    range_nm: 1300,
    speed_kts: 450,
    mtow_kg: 42500,
    fuel_burn_kgph: 3100,
    price_acs_usd: 31000000,
    engines: "Honeywell LF 507",
    required_runway_m: 1600
  },
  {
    manufacturer: "Avro",
    model: "RJ85",
    year: 1993,
    seats: 82,
    range_nm: 1500,
    speed_kts: 450,
    mtow_kg: 44000,
    fuel_burn_kgph: 3300,
    price_acs_usd: 33000000,
    engines: "Honeywell LF 507",
    required_runway_m: 1600
  },
  {
    manufacturer: "Avro",
    model: "RJ100",
    year: 1993,
    seats: 100,
    range_nm: 1600,
    speed_kts: 450,
    mtow_kg: 46000,
    fuel_burn_kgph: 3500,
    price_acs_usd: 36000000,
    engines: "Honeywell LF 507",
    required_runway_m: 1650
  },

  // 1940s
  {
    manufacturer: "Ilyushin",
    model: "Il-12",
    year: 1946,
    seats: 32,
    range_nm: 930,
    speed_kts: 190,
    mtow_kg: 18000,
    fuel_burn_kgph: 900,
    price_acs_usd: 1400000,
    engines: "Shvetsov ASh-82",
    required_runway_m: 1300
  },

  // 1950s
  {
    manufacturer: "Ilyushin",
    model: "Il-14",
    year: 1950,
    seats: 36,
    range_nm: 1350,
    speed_kts: 215,
    mtow_kg: 21000,
    fuel_burn_kgph: 1000,
    price_acs_usd: 1800000,
    engines: "Shvetsov ASh-82T",
    required_runway_m: 1350
  },

  // 1960s
  {
    manufacturer: "Ilyushin",
    model: "Il-18B",
    year: 1960,
    seats: 84,
    range_nm: 2500,
    speed_kts: 345,
    mtow_kg: 64000,
    fuel_burn_kgph: 3300,
    price_acs_usd: 13500000,
    engines: "Ivchenko AI-20",
    required_runway_m: 1700
  },
  {
    manufacturer: "Ilyushin",
    model: "Il-18V",
    year: 1961,
    seats: 100,
    range_nm: 3100,
    speed_kts: 350,
    mtow_kg: 64000,
    fuel_burn_kgph: 3400,
    price_acs_usd: 15000000,
    engines: "Ivchenko AI-20M",
    required_runway_m: 1700
  },

  // 1940s
  {
    manufacturer: "Tupolev",
    model: "Tu-70",
    year: 1946,
    seats: 48,
    range_nm: 2000,
    speed_kts: 265,
    mtow_kg: 34000,
    fuel_burn_kgph: 1700,
    price_acs_usd: 3500000,
    engines: "Shvetsov ASh-73",
    required_runway_m: 1600
  },

  // 1950s
  {
    manufacturer: "Tupolev",
    model: "Tu-104",
    year: 1956,
    seats: 70,
    range_nm: 1450,
    speed_kts: 480,
    mtow_kg: 62000,
    fuel_burn_kgph: 6200,
    price_acs_usd: 12000000,
    engines: "Mikulin AM-3",
    required_runway_m: 2550
  },
  {
    manufacturer: "Tupolev",
    model: "Tu-114",
    year: 1957,
    seats: 170,
    range_nm: 4350,
    speed_kts: 400,
    mtow_kg: 164000,
    fuel_burn_kgph: 6800,
    price_acs_usd: 30000000,
    engines: "NK-12 (turboprop)",
    required_runway_m: 2400
  },

  // 1960s
  {
    manufacturer: "Tupolev",
    model: "Tu-134",
    year: 1967,
    seats: 80,
    range_nm: 1200,
    speed_kts: 510,
    mtow_kg: 47500,
    fuel_burn_kgph: 5200,
    price_acs_usd: 16000000,
    engines: "Soloviev D-30",
    required_runway_m: 1800
  },

  // 1970s
  {
    manufacturer: "Tupolev",
    model: "Tu-154",
    year: 1972,
    seats: 164,
    range_nm: 2600,
    speed_kts: 530,
    mtow_kg: 98000,
    fuel_burn_kgph: 9200,
    price_acs_usd: 28000000,
    engines: "Soloviev D-30KU-154",
    required_runway_m: 2750
  },

  // 1950s
  {
    manufacturer: "Antonov",
    model: "An-10",
    year: 1957,
    seats: 100,
    range_nm: 1100,
    speed_kts: 345,
    mtow_kg: 56000,
    fuel_burn_kgph: 3400,
    price_acs_usd: 12000000,
    engines: "Ivchenko AI-20",
    required_runway_m: 1650
  },
  {
    manufacturer: "Antonov",
    model: "An-12",
    year: 1959,
    seats: 0,
    range_nm: 2000,
    speed_kts: 330,
    mtow_kg: 61000,
    fuel_burn_kgph: 3500,
    price_acs_usd: 16000000,
    engines: "Ivchenko AI-20M",
    status: "cargo",
    required_runway_m: 1700
  },
  {
    manufacturer: "Antonov",
    model: "An-24",
    year: 1959,
    seats: 44,
    range_nm: 1300,
    speed_kts: 240,
    mtow_kg: 21000,
    fuel_burn_kgph: 850,
    price_acs_usd: 6000000,
    engines: "Ivchenko AI-24",
    required_runway_m: 1150
  },

  // 1960s
  {
    manufacturer: "Antonov",
    model: "An-26",
    year: 1969,
    seats: 40,
    range_nm: 1000,
    speed_kts: 230,
    mtow_kg: 24000,
    fuel_burn_kgph: 900,
    price_acs_usd: 7000000,
    engines: "Ivchenko AI-24VT",
    status: "cargo/passenger",
    required_runway_m: 1250
  },

  // 1970s
  {
    manufacturer: "Antonov",
    model: "An-72",
    year: 1977,
    seats: 52,
    range_nm: 2100,
    speed_kts: 360,
    mtow_kg: 34000,
    fuel_burn_kgph: 3200,
    price_acs_usd: 17000000,
    engines: "Lotarev D-36",
    required_runway_m: 1450
  },

  // 1980s
  {
    manufacturer: "Antonov",
    model: "An-74",
    year: 1983,
    seats: 52,
    range_nm: 2300,
    speed_kts: 370,
    mtow_kg: 36000,
    fuel_burn_kgph: 3300,
    price_acs_usd: 19000000,
    engines: "Lotarev D-36",
    required_runway_m: 1450
  },

  // 1960s
  {
    manufacturer: "Yakovlev",
    model: "Yak-40",
    year: 1968,
    seats: 32,
    range_nm: 810,
    speed_kts: 245,
    mtow_kg: 16500,
    fuel_burn_kgph: 1100,
    price_acs_usd: 9000000,
    engines: "Ivchenko AI-25",
    required_runway_m: 1300
  },

  // 1980s
  {
    manufacturer: "Yakovlev",
    model: "Yak-42",
    year: 1980,
    seats: 120,
    range_nm: 1400,
    speed_kts: 405,
    mtow_kg: 57000,
    fuel_burn_kgph: 6800,
    price_acs_usd: 24000000,
    engines: "Lotarev D-36",
    required_runway_m: 1750
  },

  // 1950s
  {
    manufacturer: "Convair",
    model: "CV-540",
    year: 1955,
    seats: 48,
    range_nm: 1300,
    speed_kts: 285,
    mtow_kg: 20000,
    fuel_burn_kgph: 1100,
    price_acs_usd: 4500000,
    engines: "Napier Eland",
    required_runway_m: 1150
  },

  // 1960s
  {
    manufacturer: "Convair",
    model: "CV-580",
    year: 1965,
    seats: 50,
    range_nm: 1300,
    speed_kts: 300,
    mtow_kg: 20500,
    fuel_burn_kgph: 1200,
    price_acs_usd: 5200000,
    engines: "Allison 501-D13",
    required_runway_m: 1150
  },
  {
    manufacturer: "Convair",
    model: "CV-600",
    year: 1965,
    seats: 48,
    range_nm: 1100,
    speed_kts: 275,
    mtow_kg: 19000,
    fuel_burn_kgph: 1000,
    price_acs_usd: 4800000,
    engines: "RR Dart 510",
    required_runway_m: 1150
  },
  {
    manufacturer: "Convair",
    model: "CV-640",
    year: 1968,
    seats: 52,
    range_nm: 1150,
    speed_kts: 285,
    mtow_kg: 20000,
    fuel_burn_kgph: 1100,
    price_acs_usd: 5000000,
    engines: "RR Dart 510",
    required_runway_m: 1150
  },

  // 1940s
  {
    manufacturer: "Martin",
    model: "2-0-2",
    year: 1946,
    seats: 40,
    range_nm: 1010,
    speed_kts: 235,
    mtow_kg: 15500,
    fuel_burn_kgph: 780,
    price_acs_usd: 2900000,
    engines: "PW R-2800",
    required_runway_m: 1250
  },

  // 1950s
  {
    manufacturer: "Martin",
    model: "4-0-4",
    year: 1951,
    seats: 44,
    range_nm: 1350,
    speed_kts: 250,
    mtow_kg: 19000,
    fuel_burn_kgph: 900,
    price_acs_usd: 3400000,
    engines: "PW R-2800",
    required_runway_m: 1300
  },
  {
    manufacturer: "Sud Aviation",
    model: "Caravelle III",
    year: 1959,
    seats: 96,
    range_nm: 1450,
    speed_kts: 505,
    mtow_kg: 52000,
    fuel_burn_kgph: 4600,
    price_acs_usd: 11500000,
    engines: "RR Avon",
    required_runway_m: 2450
  },

  // 1960s
  {
    manufacturer: "Sud Aviation",
    model: "Caravelle 6R",
    year: 1960,
    seats: 98,
    range_nm: 1750,
    speed_kts: 510,
    mtow_kg: 53500,
    fuel_burn_kgph: 4900,
    price_acs_usd: 12500000,
    engines: "RR Avon RA.29",
    required_runway_m: 2450
  },
  {
    manufacturer: "Sud Aviation",
    model: "Caravelle 10B",
    year: 1964,
    seats: 109,
    range_nm: 2000,
    speed_kts: 515,
    mtow_kg: 55000,
    fuel_burn_kgph: 5100,
    price_acs_usd: 14500000,
    engines: "GE CJ805-23",
    required_runway_m: 1900
  },

  // 1970s
  {
    manufacturer: "Sud Aviation",
    model: "Caravelle 12R",
    year: 1970,
    seats: 131,
    range_nm: 2050,
    speed_kts: 520,
    mtow_kg: 57500,
    fuel_burn_kgph: 5200,
    price_acs_usd: 16500000,
    engines: "GE CJ805-23",
    required_runway_m: 1900
  },

  // 1950s
  {
    manufacturer: "Howard",
    model: "500",
    year: 1959,
    seats: 12,
    range_nm: 2450,
    speed_kts: 350,
    mtow_kg: 6800,
    fuel_burn_kgph: 640,
    price_acs_usd: 4500000,
    engines: "PW R-2800",
    required_runway_m: 950
  },
  {
    manufacturer: "Aero Commander",
    model: "500B",
    year: 1954,
    seats: 6,
    range_nm: 950,
    speed_kts: 210,
    mtow_kg: 4100,
    fuel_burn_kgph: 300,
    price_acs_usd: 1200000,
    engines: "Lycoming GO-480",
    required_runway_m: 850
  },
  {
    manufacturer: "Aero Commander",
    model: "680 Super",
    year: 1956,
    seats: 8,
    range_nm: 1500,
    speed_kts: 245,
    mtow_kg: 5200,
    fuel_burn_kgph: 350,
    price_acs_usd: 1800000,
    engines: "Continental GTSIO-520",
    required_runway_m: 900
  },
  {
    manufacturer: "Fairchild",
    model: "F-27",
    year: 1958,
    seats: 44,
    range_nm: 1210,
    speed_kts: 260,
    mtow_kg: 20000,
    fuel_burn_kgph: 900,
    price_acs_usd: 3800000,
    engines: "RR Dart 6",
    required_runway_m: 1150
  },

  // 1990s
  {
    manufacturer: "Beechcraft",
    model: "1900D",
    year: 1991,
    seats: 19,
    range_nm: 700,
    speed_kts: 280,
    mtow_kg: 7700,
    fuel_burn_kgph: 370,
    price_acs_usd: 4200000,
    engines: "PT6A-67D",
    required_runway_m: 950
  },

  // 1980s
  {
    manufacturer: "Saab",
    model: "Saab 340B",
    year: 1989,
    seats: 34,
    range_nm: 1050,
    speed_kts: 280,
    mtow_kg: 12900,
    fuel_burn_kgph: 650,
    price_acs_usd: 9500000,
    engines: "GE CT7-9B",
    required_runway_m: 1050
  },

  // 1990s
  {
    manufacturer: "Saab",
    model: "Saab 2000",
    year: 1994,
    seats: 50,
    range_nm: 1230,
    speed_kts: 360,
    mtow_kg: 22800,
    fuel_burn_kgph: 900,
    price_acs_usd: 17000000,
    engines: "RR AE2100A",
    required_runway_m: 1250
  },

  // 1980s
  {
    manufacturer: "Dornier",
    model: "Do 228-200",
    year: 1981,
    seats: 19,
    range_nm: 550,
    speed_kts: 210,
    mtow_kg: 6400,
    fuel_burn_kgph: 300,
    price_acs_usd: 5200000,
    engines: "Garrett TPE331",
    required_runway_m: 650
  },

  // 1990s
  {
    manufacturer: "Dornier",
    model: "Do 328-100",
    year: 1993,
    seats: 33,
    range_nm: 1000,
    speed_kts: 335,
    mtow_kg: 13000,
    fuel_burn_kgph: 620,
    price_acs_usd: 12500000,
    engines: "PW119B",
    required_runway_m: 1050
  },
  {
    manufacturer: "Dornier",
    model: "Do 328JET",
    year: 1999,
    seats: 32,
    range_nm: 1050,
    speed_kts: 375,
    mtow_kg: 14500,
    fuel_burn_kgph: 950,
    price_acs_usd: 16500000,
    engines: "PW306B",
    required_runway_m: 1100
  },

  // 1980s
  {
    manufacturer: "British Aerospace",
    model: "ATP",
    year: 1988,
    seats: 64,
    range_nm: 1150,
    speed_kts: 285,
    mtow_kg: 22700,
    fuel_burn_kgph: 950,
    price_acs_usd: 14000000,
    engines: "PW126",
    required_runway_m: 1250
  },
  {
    manufacturer: "British Aerospace",
    model: "Jetstream 31",
    year: 1982,
    seats: 19,
    range_nm: 630,
    speed_kts: 240,
    mtow_kg: 6400,
    fuel_burn_kgph: 330,
    price_acs_usd: 3500000,
    engines: "Garrett TPE331",
    required_runway_m: 900
  },
  {
    manufacturer: "British Aerospace",
    model: "Jetstream 32EP",
    year: 1988,
    seats: 19,
    range_nm: 690,
    speed_kts: 250,
    mtow_kg: 6800,
    fuel_burn_kgph: 360,
    price_acs_usd: 3900000,
    engines: "Garrett TPE331-12UHR",
    required_runway_m: 900
  },

  // 1990s
  {
    manufacturer: "British Aerospace",
    model: "Jetstream 41",
    year: 1992,
    seats: 29,
    range_nm: 800,
    speed_kts: 265,
    mtow_kg: 10900,
    fuel_burn_kgph: 520,
    price_acs_usd: 8500000,
    engines: "Allison 501-D22",
    required_runway_m: 1000
  },

  // 1980s
  {
    manufacturer: "LET",
    model: "L-410 UVP-E20",
    year: 1986,
    seats: 19,
    range_nm: 780,
    speed_kts: 195,
    mtow_kg: 6600,
    fuel_burn_kgph: 340,
    price_acs_usd: 4800000,
    engines: "Walter M601F",
    required_runway_m: 650
  },
  {
    manufacturer: "LET",
    model: "L-610",
    year: 1988,
    seats: 44,
    range_nm: 1100,
    speed_kts: 260,
    mtow_kg: 16500,
    fuel_burn_kgph: 900,
    price_acs_usd: 12000000,
    engines: "Walter M602",
    required_runway_m: 1100
  },

  // 1970s
  {
    manufacturer: "Shorts",
    model: "Shorts 330",
    year: 1976,
    seats: 30,
    range_nm: 700,
    speed_kts: 180,
    mtow_kg: 10000,
    fuel_burn_kgph: 420,
    price_acs_usd: 4500000,
    engines: "PT6A-45",
    required_runway_m: 700
  },

  // 1980s
  {
    manufacturer: "Shorts",
    model: "Shorts 360",
    year: 1981,
    seats: 36,
    range_nm: 900,
    speed_kts: 185,
    mtow_kg: 12000,
    fuel_burn_kgph: 460,
    price_acs_usd: 5200000,
    engines: "PT6A-65",
    required_runway_m: 700
  },
  {
    manufacturer: "CASA",
    model: "CN-235",
    year: 1986,
    seats: 48,
    range_nm: 1250,
    speed_kts: 235,
    mtow_kg: 15500,
    fuel_burn_kgph: 800,
    price_acs_usd: 18000000,
    engines: "GE CT7-9C",
    required_runway_m: 1100
  },

  // 1990s
  {
    manufacturer: "CASA",
    model: "C-295 (Civil)",
    year: 1999,
    seats: 70,
    range_nm: 1300,
    speed_kts: 260,
    mtow_kg: 23000,
    fuel_burn_kgph: 900,
    price_acs_usd: 28000000,
    engines: "PW127G",
    required_runway_m: 1250
  },
  {
    manufacturer: "Fokker",
    model: "F60",
    year: 1994,
    seats: 52,
    range_nm: 1300,
    speed_kts: 275,
    mtow_kg: 23000,
    fuel_burn_kgph: 850,
    price_acs_usd: 17500000,
    engines: "PW127B",
    required_runway_m: 1250
  },

  // 1970s
  {
    manufacturer: "Embraer",
    model: "EMB 110 Bandeirante",
    year: 1973,
    seats: 15,
    range_nm: 1000,
    speed_kts: 235,
    mtow_kg: 5700,
    fuel_burn_kgph: 350,
    price_acs_usd: 3800000,
    engines: "PT6A-34",
    required_runway_m: 900
  },

  // 1980s
  {
    manufacturer: "Embraer",
    model: "EMB 120 Brasilia",
    year: 1985,
    seats: 30,
    range_nm: 1050,
    speed_kts: 295,
    mtow_kg: 11900,
    fuel_burn_kgph: 700,
    price_acs_usd: 7800000,
    engines: "PW118",
    required_runway_m: 1050
  },
  {
    manufacturer: "Fairchild Swearingen",
    model: "Metro III",
    year: 1981,
    seats: 19,
    range_nm: 900,
    speed_kts: 285,
    mtow_kg: 6400,
    fuel_burn_kgph: 380,
    price_acs_usd: 4200000,
    engines: "Garrett TPE331-11U",
    required_runway_m: 900
  },

  // 1990s
  {
    manufacturer: "Fairchild Swearingen",
    model: "Metro 23",
    year: 1992,
    seats: 19,
    range_nm: 1050,
    speed_kts: 300,
    mtow_kg: 6650,
    fuel_burn_kgph: 400,
    price_acs_usd: 4900000,
    engines: "Garrett TPE331-12UHR",
    required_runway_m: 900
  },

  // 1980s
  {
    manufacturer: "Cessna",
    model: "208 Caravan",
    year: 1984,
    seats: 9,
    range_nm: 920,
    speed_kts: 185,
    mtow_kg: 3629,
    fuel_burn_kgph: 240,
    price_acs_usd: 2900000,
    engines: "PT6A-114A",
    required_runway_m: 850
  },

  // 1990s
  {
    manufacturer: "Cessna",
    model: "208B Grand Caravan",
    year: 1990,
    seats: 14,
    range_nm: 915,
    speed_kts: 186,
    mtow_kg: 3970,
    fuel_burn_kgph: 250,
    price_acs_usd: 3400000,
    engines: "PT6A-114A",
    required_runway_m: 850
  },

  // 2010s
  {
    manufacturer: "Cessna",
    model: "208EX Grand Caravan EX",
    year: 2013,
    seats: 14,
    range_nm: 940,
    speed_kts: 195,
    mtow_kg: 3970,
    fuel_burn_kgph: 260,
    price_acs_usd: 3800000,
    engines: "PT6A-140",
    required_runway_m: 850
  },

  // 1960s
  {
    manufacturer: "Piper",
    model: "PA-31 Navajo",
    year: 1967,
    seats: 6,
    range_nm: 880,
    speed_kts: 220,
    mtow_kg: 2948,
    fuel_burn_kgph: 220,
    price_acs_usd: 1500000,
    engines: "Lycoming TIO-540",
    required_runway_m: 750
  },

  // 1970s
  {
    manufacturer: "Piper",
    model: "PA-31-350 Chieftain",
    year: 1973,
    seats: 8,
    range_nm: 930,
    speed_kts: 225,
    mtow_kg: 3175,
    fuel_burn_kgph: 240,
    price_acs_usd: 1750000,
    engines: "Lycoming TIO-540-J2BD",
    required_runway_m: 850
  },

  // 1980s
  {
    manufacturer: "Beechcraft",
    model: "1900C",
    year: 1982,
    seats: 19,
    range_nm: 1300,
    speed_kts: 270,
    mtow_kg: 7170,
    fuel_burn_kgph: 500,
    price_acs_usd: 5800000,
    engines: "PT6A-65B",
    required_runway_m: 950
  },

  // 1970s
  {
    manufacturer: "De Havilland Canada",
    model: "DHC-6 Twin Otter Series 300",
    year: 1972,
    seats: 19,
    range_nm: 775,
    speed_kts: 180,
    mtow_kg: 5700,
    fuel_burn_kgph: 300,
    price_acs_usd: 5500000,
    engines: "PT6A-27",
    required_runway_m: 600
  },

  // 2010s
  {
    manufacturer: "De Havilland Canada",
    model: "DHC-6 Twin Otter Series 400",
    year: 2010,
    seats: 19,
    range_nm: 770,
    speed_kts: 183,
    mtow_kg: 6300,
    fuel_burn_kgph: 320,
    price_acs_usd: 7400000,
    engines: "PT6A-34",
    required_runway_m: 650
  },

  // 1970s
  {
    manufacturer: "Mitsubishi",
    model: "MU-2B-60 Marquise",
    year: 1971,
    seats: 8,
    range_nm: 1100,
    speed_kts: 290,
    mtow_kg: 4800,
    fuel_burn_kgph: 350,
    price_acs_usd: 1900000,
    engines: "Garrett TPE331-10",
    required_runway_m: 850
  },

  // 2010s
  {
    manufacturer: "Embraer",
    model: "Praetor 600",
    year: 2018,
    seats: 12,
    range_nm: 4000,
    speed_kts: 465,
    mtow_kg: 19800,
    fuel_burn_kgph: 1100,
    price_acs_usd: 22000000,
    engines: "HTF7500E",
    required_runway_m: 1250
  },
  {
    manufacturer: "Honda",
    model: "HondaJet HA-420",
    year: 2015,
    seats: 6,
    range_nm: 1200,
    speed_kts: 367,
    mtow_kg: 4800,
    fuel_burn_kgph: 420,
    price_acs_usd: 5200000,
    engines: "GE Honda HF120",
    required_runway_m: 900
  },
  {
    manufacturer: "Pilatus",
    model: "PC-24",
    year: 2017,
    seats: 11,
    range_nm: 2000,
    speed_kts: 425,
    mtow_kg: 8500,
    fuel_burn_kgph: 620,
    price_acs_usd: 11500000,
    engines: "Williams FJ44-4A",
    required_runway_m: 1000
  },

  // 1960s
  {
    manufacturer: "Bell",
    model: "Bell 206B JetRanger",
    year: 1967,
    seats: 5,
    range_nm: 374,
    speed_kts: 110,
    mtow_kg: 1450,
    fuel_burn_kgph: 105,
    price_acs_usd: 900000,
    engines: "Allison 250-C20",
    required_runway_m: 0
  },
  {
    manufacturer: "Bell",
    model: "Bell 212",
    year: 1968,
    seats: 14,
    range_nm: 230,
    speed_kts: 120,
    mtow_kg: 5080,
    fuel_burn_kgph: 380,
    price_acs_usd: 5500000,
    engines: "PT6T-3 Twin-Pac",
    required_runway_m: 900
  },

  // 1980s
  {
    manufacturer: "Bell",
    model: "Bell 412EP",
    year: 1981,
    seats: 15,
    range_nm: 350,
    speed_kts: 122,
    mtow_kg: 5400,
    fuel_burn_kgph: 440,
    price_acs_usd: 9000000,
    engines: "PT6T-9 Twin-Pac",
    required_runway_m: 900
  },

  // 1990s
  {
    manufacturer: "Airbus Helicopters",
    model: "H120 (EC120 Colibri)",
    year: 1997,
    seats: 5,
    range_nm: 383,
    speed_kts: 122,
    mtow_kg: 1715,
    fuel_burn_kgph: 115,
    price_acs_usd: 2300000,
    engines: "Turbomeca Arrius 2F",
    required_runway_m: 0
  },

  // 1970s
  {
    manufacturer: "Airbus Helicopters",
    model: "H125 (AS350 Écureuil)",
    year: 1975,
    seats: 6,
    range_nm: 345,
    speed_kts: 133,
    mtow_kg: 2250,
    fuel_burn_kgph: 165,
    price_acs_usd: 3100000,
    engines: "Safran Arriel 2D",
    required_runway_m: 0
  },

  // 1990s
  {
    manufacturer: "Airbus Helicopters",
    model: "H135 (EC135)",
    year: 1996,
    seats: 7,
    range_nm: 330,
    speed_kts: 137,
    mtow_kg: 2980,
    fuel_burn_kgph: 280,
    price_acs_usd: 6500000,
    engines: "PW206B",
    required_runway_m: 0
  },

  // 2010s
  {
    manufacturer: "Airbus Helicopters",
    model: "H145",
    year: 2014,
    seats: 10,
    range_nm: 351,
    speed_kts: 137,
    mtow_kg: 3800,
    fuel_burn_kgph: 320,
    price_acs_usd: 9500000,
    engines: "Arriel 2E",
    required_runway_m: 0
  },

  // 1990s
  {
    manufacturer: "Airbus Helicopters",
    model: "H155 (EC155)",
    year: 1999,
    seats: 13,
    range_nm: 423,
    speed_kts: 150,
    mtow_kg: 4800,
    fuel_burn_kgph: 520,
    price_acs_usd: 11000000,
    engines: "Arriel 2C2",
    required_runway_m: 0
  },

  // 2000s
  {
    manufacturer: "Airbus Helicopters",
    model: "H225 Super Puma",
    year: 2004,
    seats: 24,
    range_nm: 452,
    speed_kts: 150,
    mtow_kg: 11100,
    fuel_burn_kgph: 900,
    price_acs_usd: 27000000,
    engines: "Makila 2A1",
    required_runway_m: 0
  },

  // 1990s
  {
    manufacturer: "Leonardo",
    model: "AW109 GrandNew",
    year: 1996,
    seats: 7,
    range_nm: 432,
    speed_kts: 154,
    mtow_kg: 3175,
    fuel_burn_kgph: 260,
    price_acs_usd: 6500000,
    engines: "PW207C",
    required_runway_m: 0
  },

  // 2000s
  {
    manufacturer: "Leonardo",
    model: "AW139",
    year: 2003,
    seats: 15,
    range_nm: 573,
    speed_kts: 165,
    mtow_kg: 6800,
    fuel_burn_kgph: 520,
    price_acs_usd: 16500000,
    engines: "PT6C-67C",
    required_runway_m: 900
  },

  // 2010s
  {
    manufacturer: "Leonardo",
    model: "AW169",
    year: 2015,
    seats: 10,
    range_nm: 410,
    speed_kts: 150,
    mtow_kg: 4600,
    fuel_burn_kgph: 400,
    price_acs_usd: 12000000,
    engines: "PW210A",
    required_runway_m: 0
  },
  {
    manufacturer: "Leonardo",
    model: "AW189",
    year: 2013,
    seats: 19,
    range_nm: 520,
    speed_kts: 150,
    mtow_kg: 8600,
    fuel_burn_kgph: 720,
    price_acs_usd: 21000000,
    engines: "CT7-2E1",
    required_runway_m: 950
  },

  // 2000s
  {
    manufacturer: "Sikorsky",
    model: "S-76C++",
    year: 2005,
    seats: 12,
    range_nm: 411,
    speed_kts: 155,
    mtow_kg: 5300,
    fuel_burn_kgph: 460,
    price_acs_usd: 12500000,
    engines: "Arriel 2S2",
    required_runway_m: 0
  },
  {
    manufacturer: "Sikorsky",
    model: "S-92",
    year: 2004,
    seats: 19,
    range_nm: 480,
    speed_kts: 165,
    mtow_kg: 12000,
    fuel_burn_kgph: 780,
    price_acs_usd: 27000000,
    engines: "CT7-8A",
    required_runway_m: 1050
  },

  // 1960s
  {
    manufacturer: "Sikorsky",
    model: "S-64 Skycrane",
    year: 1962,
    seats: 2,
    range_nm: 200,
    speed_kts: 100,
    mtow_kg: 19000,
    fuel_burn_kgph: 1100,
    price_acs_usd: 24000000,
    engines: "Pratt & Whitney JFTD12A",
    required_runway_m: 0
  },
  {
    manufacturer: "Mil",
    model: "Mi-2",
    year: 1965,
    seats: 8,
    range_nm: 200,
    speed_kts: 105,
    mtow_kg: 3550,
    fuel_burn_kgph: 420,
    price_acs_usd: 1500000,
    engines: "GTXD-350",
    required_runway_m: 0
  },
  {
    manufacturer: "Mil",
    model: "Mi-8/17 Hip",
    year: 1967,
    seats: 24,
    range_nm: 280,
    speed_kts: 135,
    mtow_kg: 13000,
    fuel_burn_kgph: 900,
    price_acs_usd: 8000000,
    engines: "TV2-117",
    required_runway_m: 0
  },

  // 2010s
  {
    manufacturer: "Mil",
    model: "Mi-171A2",
    year: 2015,
    seats: 24,
    range_nm: 400,
    speed_kts: 135,
    mtow_kg: 13000,
    fuel_burn_kgph: 920,
    price_acs_usd: 15000000,
    engines: "VK-2500PS-03",
    required_runway_m: 0
  },

  // 1980s
  {
    manufacturer: "Mil",
    model: "Mi-26 Halo",
    year: 1983,
    seats: 80,
    range_nm: 500,
    speed_kts: 159,
    mtow_kg: 56000,
    fuel_burn_kgph: 3500,
    price_acs_usd: 36000000,
    engines: "D-136",
    required_runway_m: 0
  },

  // 1970s
  {
    manufacturer: "Robinson",
    model: "R22 Beta II",
    year: 1979,
    seats: 2,
    range_nm: 240,
    speed_kts: 96,
    mtow_kg: 622,
    fuel_burn_kgph: 55,
    price_acs_usd: 350000,
    engines: "Lycoming O-360",
    required_runway_m: 600
  },

  // 1990s
  {
    manufacturer: "Robinson",
    model: "R44 Raven II",
    year: 1997,
    seats: 4,
    range_nm: 300,
    speed_kts: 110,
    mtow_kg: 1130,
    fuel_burn_kgph: 75,
    price_acs_usd: 550000,
    engines: "Lycoming IO-540",
    required_runway_m: 650
  },

  // 2010s
  {
    manufacturer: "Robinson",
    model: "R66 Turbine",
    year: 2010,
    seats: 5,
    range_nm: 350,
    speed_kts: 120,
    mtow_kg: 1220,
    fuel_burn_kgph: 110,
    price_acs_usd: 950000,
    engines: "RR300",
    required_runway_m: 0
  },

  // 1930s
  {
    manufacturer: "Beechcraft",
    model: "Model 18",
    year: 1937,
    seats: 9,
    range_nm: 1200,
    speed_kts: 200,
    mtow_kg: 3800,
    fuel_burn_kgph: 240,
    price_acs_usd: 650000,
    engines: "PW R-985",
    required_runway_m: 850
  },

  // 1960s
  {
    manufacturer: "Piper",
    model: "PA-32 Cherokee Six",
    year: 1965,
    seats: 6,
    range_nm: 600,
    speed_kts: 140,
    mtow_kg: 1580,
    fuel_burn_kgph: 55,
    price_acs_usd: 650000,
    engines: "Lycoming IO-540",
    required_runway_m: 700
  },

  // 1970s
  {
    manufacturer: "Piper",
    model: "PA-34 Seneca II",
    year: 1975,
    seats: 6,
    range_nm: 820,
    speed_kts: 180,
    mtow_kg: 2150,
    fuel_burn_kgph: 95,
    price_acs_usd: 1100000,
    engines: "Continental TSIO-360",
    required_runway_m: 750
  },

  // 1960s
  {
    manufacturer: "Beechcraft",
    model: "Baron 58",
    year: 1969,
    seats: 6,
    range_nm: 900,
    speed_kts: 200,
    mtow_kg: 2490,
    fuel_burn_kgph: 110,
    price_acs_usd: 1600000,
    engines: "Continental IO-550",
    required_runway_m: 750
  },

  // 1950s
  {
    manufacturer: "Cessna",
    model: "Cessna 310R",
    year: 1954,
    seats: 6,
    range_nm: 650,
    speed_kts: 190,
    mtow_kg: 2490,
    fuel_burn_kgph: 105,
    price_acs_usd: 900000,
    engines: "Continental IO-470",
    required_runway_m: 750
  },

  // 1990s
  {
    manufacturer: "Pilatus",
    model: "PC-12 NG",
    year: 1994,
    seats: 9,
    range_nm: 1800,
    speed_kts: 270,
    mtow_kg: 4740,
    fuel_burn_kgph: 270,
    price_acs_usd: 5200000,
    engines: "PT6A-67P",
    required_runway_m: 850
  },

  // 2020s
  {
    manufacturer: "Pilatus",
    model: "PC-12 NGX",
    year: 2020,
    seats: 9,
    range_nm: 1840,
    speed_kts: 290,
    mtow_kg: 4800,
    fuel_burn_kgph: 260,
    price_acs_usd: 6300000,
    engines: "PT6E-67XP",
    required_runway_m: 850
  },

  // 2010s
  {
    manufacturer: "Daher",
    model: "TBM 910",
    year: 2017,
    seats: 6,
    range_nm: 1730,
    speed_kts: 285,
    mtow_kg: 3350,
    fuel_burn_kgph: 225,
    price_acs_usd: 4500000,
    engines: "PT6A-66D",
    required_runway_m: 850
  },

  // 2020s
  {
    manufacturer: "Daher",
    model: "TBM 960",
    year: 2022,
    seats: 6,
    range_nm: 1700,
    speed_kts: 285,
    mtow_kg: 3380,
    fuel_burn_kgph: 215,
    price_acs_usd: 5200000,
    engines: "PT6E-66XT",
    required_runway_m: 850
  },

  // 2000s
  {
    manufacturer: "Beechcraft",
    model: "King Air C90GTx",
    year: 2009,
    seats: 7,
    range_nm: 1200,
    speed_kts: 260,
    mtow_kg: 4580,
    fuel_burn_kgph: 300,
    price_acs_usd: 3500000,
    engines: "PT6A-135A",
    required_runway_m: 850
  },

  // 2010s
  {
    manufacturer: "Beechcraft",
    model: "King Air 350i",
    year: 2010,
    seats: 11,
    range_nm: 1800,
    speed_kts: 310,
    mtow_kg: 6800,
    fuel_burn_kgph: 360,
    price_acs_usd: 7800000,
    engines: "PT6A-60A",
    required_runway_m: 900
  },

  // 1960s
  {
    manufacturer: "De Havilland Canada",
    model: "DHC-6 Twin Otter Series 100",
    year: 1966,
    seats: 19,
    range_nm: 770,
    speed_kts: 155,
    mtow_kg: 5670,
    fuel_burn_kgph: 320,
    price_acs_usd: 2100000,
    engines: "PT6A-20",
    required_runway_m: 600
  },

  // 2010s
  {
    manufacturer: "Viking Air",
    model: "Twin Otter Series 400",
    year: 2010,
    seats: 19,
    range_nm: 940,
    speed_kts: 180,
    mtow_kg: 6354,
    fuel_burn_kgph: 360,
    price_acs_usd: 6500000,
    engines: "PT6A-34",
    required_runway_m: 650
  },

  // 1960s
  {
    manufacturer: "Britten-Norman",
    model: "BN-2A Islander",
    year: 1967,
    seats: 9,
    range_nm: 740,
    speed_kts: 135,
    mtow_kg: 2990,
    fuel_burn_kgph: 115,
    price_acs_usd: 850000,
    engines: "Lycoming O-540",
    required_runway_m: 550
  },

  // 1970s
  {
    manufacturer: "Britten-Norman",
    model: "BN-2B Islander Turbo",
    year: 1978,
    seats: 9,
    range_nm: 700,
    speed_kts: 155,
    mtow_kg: 3100,
    fuel_burn_kgph: 160,
    price_acs_usd: 1800000,
    engines: "Allison 250-B17C",
    required_runway_m: 0
  },
  {
    manufacturer: "Britten-Norman",
    model: "BN-2A Trislander",
    year: 1970,
    seats: 17,
    range_nm: 620,
    speed_kts: 150,
    mtow_kg: 4800,
    fuel_burn_kgph: 210,
    price_acs_usd: 2200000,
    engines: "Lycoming IO-540 (x3)",
    required_runway_m: 600
  },
  {
    manufacturer: "LET Aircraft",
    model: "L-410 UVP-E20",
    year: 1977,
    seats: 19,
    range_nm: 820,
    speed_kts: 165,
    mtow_kg: 6400,
    fuel_burn_kgph: 350,
    price_acs_usd: 4900000,
    engines: "Walter M601",
    required_runway_m: 650
  },

  // 1980s
  {
    manufacturer: "LET Aircraft",
    model: "L-610",
    year: 1988,
    seats: 40,
    range_nm: 900,
    speed_kts: 210,
    mtow_kg: 14000,
    fuel_burn_kgph: 700,
    price_acs_usd: 11000000,
    engines: "Walter M602",
    required_runway_m: 1050
  },

  // 1970s
  {
    manufacturer: "CASA",
    model: "C-212 Aviocar",
    year: 1971,
    seats: 26,
    range_nm: 540,
    speed_kts: 180,
    mtow_kg: 7800,
    fuel_burn_kgph: 330,
    price_acs_usd: 3500000,
    engines: "Garrett TPE331",
    required_runway_m: 650
  },

  // 1990s
  {
    manufacturer: "Airbus Military",
    model: "C-295",
    year: 1999,
    seats: 71,
    range_nm: 2300,
    speed_kts: 260,
    mtow_kg: 23000,
    fuel_burn_kgph: 840,
    price_acs_usd: 38000000,
    engines: "PW127G",
    required_runway_m: 1250
  },

  // 2000s
  {
    manufacturer: "Antonov",
    model: "An-140",
    year: 2002,
    seats: 52,
    range_nm: 1300,
    speed_kts: 280,
    mtow_kg: 21500,
    fuel_burn_kgph: 820,
    price_acs_usd: 18000000,
    engines: "TV3-117VMA-SBM1",
    required_runway_m: 0
  },

  // 1980s
  {
    manufacturer: "Fairchild",
    model: "Swearingen Metro III",
    year: 1981,
    seats: 19,
    range_nm: 600,
    speed_kts: 265,
    mtow_kg: 6400,
    fuel_burn_kgph: 420,
    price_acs_usd: 3500000,
    engines: "Garrett TPE331-11U",
    required_runway_m: 900
  },
  {
    manufacturer: "BAe",
    model: "Jetstream 31",
    year: 1982,
    seats: 19,
    range_nm: 600,
    speed_kts: 235,
    mtow_kg: 7100,
    fuel_burn_kgph: 400,
    price_acs_usd: 4200000,
    engines: "Garrett TPE331-10",
    required_runway_m: 950
  },

  // 1990s
  {
    manufacturer: "BAe",
    model: "Jetstream 41",
    year: 1991,
    seats: 29,
    range_nm: 775,
    speed_kts: 310,
    mtow_kg: 10400,
    fuel_burn_kgph: 650,
    price_acs_usd: 9000000,
    engines: "Allison 2500",
    required_runway_m: 1000
  },
  {
    manufacturer: "Harbin",
    model: "Y-12 IV",
    year: 1990,
    seats: 17,
    range_nm: 650,
    speed_kts: 180,
    mtow_kg: 5700,
    fuel_burn_kgph: 350,
    price_acs_usd: 3500000,
    engines: "PT6A-34",
    required_runway_m: 900
  },

  // 2010s
  {
    manufacturer: "Harbin",
    model: "Y-12F",
    year: 2012,
    seats: 19,
    range_nm: 820,
    speed_kts: 210,
    mtow_kg: 8000,
    fuel_burn_kgph: 430,
    price_acs_usd: 6900000,
    engines: "PW127",
    required_runway_m: 950
  },

  // 2000s
  {
    manufacturer: "AVIC",
    model: "MA60",
    year: 2000,
    seats: 60,
    range_nm: 1000,
    speed_kts: 265,
    mtow_kg: 21000,
    fuel_burn_kgph: 950,
    price_acs_usd: 22000000,
    engines: "PW127J",
    required_runway_m: 1150
  },
  {
    manufacturer: "AVIC",
    model: "MA600",
    year: 2008,
    seats: 60,
    range_nm: 1150,
    speed_kts: 275,
    mtow_kg: 21500,
    fuel_burn_kgph: 920,
    price_acs_usd: 26000000,
    engines: "PW127J",
    required_runway_m: 1250
  },

  // 2020s
  {
    manufacturer: "AVIC",
    model: "MA700",
    year: 2023,
    seats: 78,
    range_nm: 1250,
    speed_kts: 300,
    mtow_kg: 27500,
    fuel_burn_kgph: 880,
    price_acs_usd: 34000000,
    engines: "PW150D",
    required_runway_m: 1300
  },

  // 2010s
  {
    manufacturer: "Embraer",
    model: "Praetor 500",
    year: 2019,
    seats: 9,
    range_nm: 3250,
    speed_kts: 460,
    mtow_kg: 17700,
    fuel_burn_kgph: 980,
    price_acs_usd: 21000000,
    engines: "Honeywell HTF7500E",
    required_runway_m: 1150
  },

  // 1930s
  {
    manufacturer: "Lockheed",
    model: "L-10 Electra",
    year: 1935,
    seats: 10,
    range_nm: 750,
    speed_kts: 165,
    mtow_kg: 4500,
    fuel_burn_kgph: 320,
    price_acs_usd: 350000,
    engines: "PW R-985",
    required_runway_m: 900
  },
  {
    manufacturer: "Lockheed",
    model: "L-12 Electra Junior",
    year: 1936,
    seats: 6,
    range_nm: 700,
    speed_kts: 175,
    mtow_kg: 3500,
    fuel_burn_kgph: 280,
    price_acs_usd: 300000,
    engines: "PW R-985",
    required_runway_m: 850
  },
  {
    manufacturer: "Lockheed",
    model: "L-14 Super Electra",
    year: 1937,
    seats: 14,
    range_nm: 1625,
    speed_kts: 230,
    mtow_kg: 8250,
    fuel_burn_kgph: 520,
    price_acs_usd: 520000,
    engines: "PW R-1690",
    required_runway_m: 1000
  },

  // 1940s
  {
    manufacturer: "Lockheed",
    model: "L-18 Lodestar",
    year: 1940,
    seats: 18,
    range_nm: 1500,
    speed_kts: 250,
    mtow_kg: 8350,
    fuel_burn_kgph: 580,
    price_acs_usd: 650000,
    engines: "PW R-1820",
    required_runway_m: 1000
  },

  // 1930s
  {
    manufacturer: "Douglas",
    model: "DC-2",
    year: 1934,
    seats: 14,
    range_nm: 1000,
    speed_kts: 200,
    mtow_kg: 8100,
    fuel_burn_kgph: 480,
    price_acs_usd: 600000,
    engines: "PW R-1690",
    required_runway_m: 1000
  },
  {
    manufacturer: "Douglas",
    model: "DC-3",
    year: 1935,
    seats: 21,
    range_nm: 1500,
    speed_kts: 180,
    mtow_kg: 11793,
    fuel_burn_kgph: 450,
    price_acs_usd: 700000,
    engines: "PW R-1830",
    required_runway_m: 1100
  },

  // 1940s
  {
    manufacturer: "Douglas",
    model: "DC-4",
    year: 1942,
    seats: 44,
    range_nm: 2500,
    speed_kts: 215,
    mtow_kg: 29700,
    fuel_burn_kgph: 1350,
    price_acs_usd: 2200000,
    engines: "PW R-2000",
    required_runway_m: 1500
  },

  // 1930s
  {
    manufacturer: "Douglas",
    model: "DC-5",
    year: 1939,
    seats: 16,
    range_nm: 1200,
    speed_kts: 190,
    mtow_kg: 7600,
    fuel_burn_kgph: 420,
    price_acs_usd: 550000,
    engines: "PW R-1820",
    required_runway_m: 1000
  },

  // 1940s
  {
    manufacturer: "Douglas",
    model: "DC-6",
    year: 1946,
    seats: 52,
    range_nm: 4000,
    speed_kts: 245,
    mtow_kg: 48800,
    fuel_burn_kgph: 2200,
    price_acs_usd: 3200000,
    engines: "PW R-2800",
    required_runway_m: 1800
  },
  {
    manufacturer: "Lockheed",
    model: "L-049 Constellation",
    year: 1943,
    seats: 44,
    range_nm: 2600,
    speed_kts: 280,
    mtow_kg: 43700,
    fuel_burn_kgph: 2000,
    price_acs_usd: 3500000,
    engines: "Wright R-3350",
    required_runway_m: 1750
  },
  {
    manufacturer: "Lockheed",
    model: "L-649 Constellation",
    year: 1946,
    seats: 52,
    range_nm: 3200,
    speed_kts: 300,
    mtow_kg: 49300,
    fuel_burn_kgph: 2400,
    price_acs_usd: 3800000,
    engines: "Wright R-3350",
    required_runway_m: 1800
  },
  {
    manufacturer: "Lockheed",
    model: "L-749 Constellation",
    year: 1947,
    seats: 60,
    range_nm: 4000,
    speed_kts: 305,
    mtow_kg: 51300,
    fuel_burn_kgph: 2550,
    price_acs_usd: 4200000,
    engines: "Wright R-3350",
    required_runway_m: 1850
  },

  // 1930s
  {
    manufacturer: "Boeing",
    model: "307 Stratoliner",
    year: 1938,
    seats: 33,
    range_nm: 1300,
    speed_kts: 200,
    mtow_kg: 15500,
    fuel_burn_kgph: 900,
    price_acs_usd: 900000,
    engines: "Wright R-1820",
    required_runway_m: 1250
  },

  // 1950s
  {
    manufacturer: "Douglas",
    model: "DC-7",
    year: 1953,
    seats: 69,
    range_nm: 4000,
    speed_kts: 315,
    mtow_kg: 63200,
    fuel_burn_kgph: 3000,
    price_acs_usd: 4800000,
    engines: "Wright R-3350",
    required_runway_m: 2050
  },
  {
    manufacturer: "Lockheed",
    model: "L-1049 Super Constellation",
    year: 1951,
    seats: 95,
    range_nm: 3400,
    speed_kts: 310,
    mtow_kg: 70000,
    fuel_burn_kgph: 3200,
    price_acs_usd: 5200000,
    engines: "Wright R-3350",
    required_runway_m: 2100
  },
  {
    manufacturer: "Lockheed",
    model: "L-1649 Starliner",
    year: 1956,
    seats: 99,
    range_nm: 4500,
    speed_kts: 335,
    mtow_kg: 74000,
    fuel_burn_kgph: 3400,
    price_acs_usd: 5800000,
    engines: "Wright R-3350",
    required_runway_m: 2150
  },
  {
    manufacturer: "Boeing",
    model: "707-120",
    year: 1958,
    seats: 110,
    range_nm: 3200,
    speed_kts: 540,
    mtow_kg: 123000,
    fuel_burn_kgph: 6500,
    price_acs_usd: 16000000,
    engines: "JT3C",
    required_runway_m: 3450
  },
  {
    manufacturer: "Boeing",
    model: "707-320",
    year: 1959,
    seats: 147,
    range_nm: 3900,
    speed_kts: 560,
    mtow_kg: 151000,
    fuel_burn_kgph: 7200,
    price_acs_usd: 18500000,
    engines: "JT4A",
    required_runway_m: 3450
  },
  {
    manufacturer: "Douglas",
    model: "DC-8-10",
    year: 1959,
    seats: 125,
    range_nm: 3500,
    speed_kts: 545,
    mtow_kg: 120000,
    fuel_burn_kgph: 6800,
    price_acs_usd: 15500000,
    engines: "JT3C",
    required_runway_m: 3250
  },

  // 1960s
  {
    manufacturer: "Douglas",
    model: "DC-8-50",
    year: 1961,
    seats: 146,
    range_nm: 4150,
    speed_kts: 565,
    mtow_kg: 147000,
    fuel_burn_kgph: 6900,
    price_acs_usd: 17500000,
    engines: "JT3D",
    required_runway_m: 3350
  },

  // 1950s
  {
    manufacturer: "Sud Aviation",
    model: "Caravelle",
    year: 1959,
    seats: 90,
    range_nm: 1500,
    speed_kts: 510,
    mtow_kg: 51000,
    fuel_burn_kgph: 4700,
    price_acs_usd: 11000000,
    engines: "RR Avon",
    required_runway_m: 2450
  },

  // 1960s
  {
    manufacturer: "BAC",
    model: "One-Eleven",
    year: 1963,
    seats: 89,
    range_nm: 1300,
    speed_kts: 470,
    mtow_kg: 37500,
    fuel_burn_kgph: 3200,
    price_acs_usd: 9000000,
    engines: "RR Spey",
    required_runway_m: 1700
  },

  // 1950s
  {
    manufacturer: "Fokker",
    model: "F27",
    year: 1958,
    seats: 48,
    range_nm: 1350,
    speed_kts: 250,
    mtow_kg: 20000,
    fuel_burn_kgph: 900,
    price_acs_usd: 3500000,
    engines: "RR Dart",
    required_runway_m: 1150
  },

  // 1960s
  {
    manufacturer: "Hawker Siddeley",
    model: "HS-748",
    year: 1960,
    seats: 52,
    range_nm: 1550,
    speed_kts: 265,
    mtow_kg: 23000,
    fuel_burn_kgph: 1050,
    price_acs_usd: 3800000,
    engines: "RR Dart",
    required_runway_m: 1250
  },
  {
    manufacturer: "Boeing",
    model: "727-100",
    year: 1963,
    seats: 106,
    range_nm: 1850,
    speed_kts: 540,
    mtow_kg: 77000,
    fuel_burn_kgph: 5100,
    price_acs_usd: 14500000,
    engines: "JT8D",
    required_runway_m: 2150
  },
  {
    manufacturer: "Boeing",
    model: "737-100",
    year: 1967,
    seats: 85,
    range_nm: 1200,
    speed_kts: 515,
    mtow_kg: 50000,
    fuel_burn_kgph: 3800,
    price_acs_usd: 11000000,
    engines: "JT8D",
    required_runway_m: 1850
  },
  {
    manufacturer: "Boeing",
    model: "737-200",
    year: 1968,
    seats: 98,
    range_nm: 1500,
    speed_kts: 520,
    mtow_kg: 52000,
    fuel_burn_kgph: 4000,
    price_acs_usd: 12500000,
    engines: "JT8D",
    required_runway_m: 1850
  },

  // 1970s
  {
    manufacturer: "Boeing",
    model: "747-100",
    year: 1970,
    seats: 366,
    range_nm: 4800,
    speed_kts: 555,
    mtow_kg: 333000,
    fuel_burn_kgph: 22000,
    price_acs_usd: 35000000,
    engines: "JT9D",
    required_runway_m: 3550
  },
  {
    manufacturer: "Boeing",
    model: "747-200",
    year: 1971,
    seats: 370,
    range_nm: 5200,
    speed_kts: 560,
    mtow_kg: 378000,
    fuel_burn_kgph: 23000,
    price_acs_usd: 38000000,
    engines: "JT9D",
    required_runway_m: 3550
  },
  {
    manufacturer: "Douglas",
    model: "DC-10-10",
    year: 1971,
    seats: 250,
    range_nm: 3200,
    speed_kts: 540,
    mtow_kg: 240000,
    fuel_burn_kgph: 15500,
    price_acs_usd: 29000000,
    engines: "GE CF6-6",
    required_runway_m: 3350
  },
  {
    manufacturer: "Lockheed",
    model: "L-1011 TriStar",
    year: 1972,
    seats: 256,
    range_nm: 3200,
    speed_kts: 540,
    mtow_kg: 231000,
    fuel_burn_kgph: 15000,
    price_acs_usd: 30000000,
    engines: "RR RB211",
    required_runway_m: 3200
  },
  {
    manufacturer: "Airbus",
    model: "A300B2",
    year: 1974,
    seats: 266,
    range_nm: 2250,
    speed_kts: 510,
    mtow_kg: 142000,
    fuel_burn_kgph: 9000,
    price_acs_usd: 25000000,
    engines: "GE CF6-50",
    required_runway_m: 2750
  },
  {
    manufacturer: "Airbus",
    model: "A300B4",
    year: 1979,
    seats: 266,
    range_nm: 2600,
    speed_kts: 510,
    mtow_kg: 165000,
    fuel_burn_kgph: 9200,
    price_acs_usd: 28000000,
    engines: "GE CF6-50",
    required_runway_m: 2600
  },

  // 1980s
  {
    manufacturer: "Airbus",
    model: "A310-300",
    year: 1985,
    seats: 247,
    range_nm: 4250,
    speed_kts: 500,
    mtow_kg: 164000,
    fuel_burn_kgph: 8800,
    price_acs_usd: 32000000,
    engines: "GE CF6-80C2",
    required_runway_m: 2600
  },
  {
    manufacturer: "McDonnell Douglas",
    model: "MD-80",
    year: 1980,
    seats: 140,
    range_nm: 1800,
    speed_kts: 480,
    mtow_kg: 63000,
    fuel_burn_kgph: 3500,
    price_acs_usd: 21000000,
    engines: "JT8D-200",
    required_runway_m: 2300
  },
  {
    manufacturer: "McDonnell Douglas",
    model: "MD-82",
    year: 1981,
    seats: 155,
    range_nm: 1850,
    speed_kts: 485,
    mtow_kg: 68000,
    fuel_burn_kgph: 3600,
    price_acs_usd: 22500000,
    engines: "JT8D-217",
    required_runway_m: 1850
  },
  {
    manufacturer: "Boeing",
    model: "737-300",
    year: 1984,
    seats: 149,
    range_nm: 1950,
    speed_kts: 490,
    mtow_kg: 62000,
    fuel_burn_kgph: 3400,
    price_acs_usd: 23000000,
    engines: "CFM56-3",
    required_runway_m: 1800
  },
  {
    manufacturer: "Boeing",
    model: "737-400",
    year: 1988,
    seats: 168,
    range_nm: 1850,
    speed_kts: 490,
    mtow_kg: 68000,
    fuel_burn_kgph: 3550,
    price_acs_usd: 24000000,
    engines: "CFM56-3",
    required_runway_m: 1850
  },
  {
    manufacturer: "Boeing",
    model: "757-200",
    year: 1983,
    seats: 200,
    range_nm: 3900,
    speed_kts: 495,
    mtow_kg: 115000,
    fuel_burn_kgph: 5200,
    price_acs_usd: 35000000,
    engines: "RB211-535",
    required_runway_m: 2500
  },
  {
    manufacturer: "Boeing",
    model: "767-200",
    year: 1982,
    seats: 216,
    range_nm: 3300,
    speed_kts: 510,
    mtow_kg: 135000,
    fuel_burn_kgph: 7000,
    price_acs_usd: 42000000,
    engines: "JT9D-7R4",
    required_runway_m: 2500
  },
  {
    manufacturer: "Boeing",
    model: "767-300",
    year: 1986,
    seats: 269,
    range_nm: 3600,
    speed_kts: 510,
    mtow_kg: 158000,
    fuel_burn_kgph: 7600,
    price_acs_usd: 51000000,
    engines: "CF6-80C2",
    required_runway_m: 2550
  },

  // 1960s
  {
    manufacturer: "Fokker",
    model: "F28 Fellowship",
    year: 1969,
    seats: 65,
    range_nm: 1100,
    speed_kts: 465,
    mtow_kg: 28500,
    fuel_burn_kgph: 2800,
    price_acs_usd: 8500000,
    engines: "RR Spey",
    required_runway_m: 1500
  },

  // 1980s
  {
    manufacturer: "Fokker",
    model: "F70",
    year: 1987,
    seats: 80,
    range_nm: 1500,
    speed_kts: 470,
    mtow_kg: 38000,
    fuel_burn_kgph: 3000,
    price_acs_usd: 12000000,
    engines: "RR Tay",
    required_runway_m: 2000
  },
  {
    manufacturer: "Fokker",
    model: "F100",
    year: 1988,
    seats: 107,
    range_nm: 1400,
    speed_kts: 475,
    mtow_kg: 45000,
    fuel_burn_kgph: 3200,
    price_acs_usd: 14000000,
    engines: "RR Tay",
    required_runway_m: 2100
  },

  // 1990s
  {
    manufacturer: "Boeing",
    model: "737-600",
    year: 1998,
    seats: 110,
    range_nm: 3050,
    speed_kts: 515,
    mtow_kg: 65000,
    fuel_burn_kgph: 2600,
    price_acs_usd: 48000000,
    engines: "CFM56-7B",
    required_runway_m: 1800
  },
  {
    manufacturer: "Boeing",
    model: "737-700",
    year: 1998,
    seats: 132,
    range_nm: 3200,
    speed_kts: 515,
    mtow_kg: 70000,
    fuel_burn_kgph: 2700,
    price_acs_usd: 56000000,
    engines: "CFM56-7B",
    required_runway_m: 1850
  },
  {
    manufacturer: "Boeing",
    model: "737-800",
    year: 1998,
    seats: 162,
    range_nm: 2935,
    speed_kts: 515,
    mtow_kg: 79000,
    fuel_burn_kgph: 2900,
    price_acs_usd: 68000000,
    engines: "CFM56-7B",
    required_runway_m: 2000
  },

  // 2000s
  {
    manufacturer: "Boeing",
    model: "737-900ER",
    year: 2007,
    seats: 180,
    range_nm: 2950,
    speed_kts: 515,
    mtow_kg: 85000,
    fuel_burn_kgph: 3050,
    price_acs_usd: 75000000,
    engines: "CFM56-7B",
    required_runway_m: 2000
  },

  // 1980s
  {
    manufacturer: "Boeing",
    model: "747-400",
    year: 1989,
    seats: 416,
    range_nm: 7250,
    speed_kts: 567,
    mtow_kg: 396900,
    fuel_burn_kgph: 25000,
    price_acs_usd: 180000000,
    engines: "PW4062 / RB211 / CF6-80",
    required_runway_m: 3650
  },

  // 1990s
  {
    manufacturer: "Boeing",
    model: "757-300",
    year: 1999,
    seats: 243,
    range_nm: 3400,
    speed_kts: 470,
    mtow_kg: 123000,
    fuel_burn_kgph: 5600,
    price_acs_usd: 80000000,
    engines: "RB211-535E4",
    required_runway_m: 2500
  },

  // 2000s
  {
    manufacturer: "Boeing",
    model: "767-400ER",
    year: 2000,
    seats: 304,
    range_nm: 5625,
    speed_kts: 530,
    mtow_kg: 204000,
    fuel_burn_kgph: 8200,
    price_acs_usd: 145000000,
    engines: "CF6-80C2",
    required_runway_m: 3000
  },

  // 1990s
  {
    manufacturer: "Boeing",
    model: "777-200",
    year: 1995,
    seats: 314,
    range_nm: 5100,
    speed_kts: 560,
    mtow_kg: 247000,
    fuel_burn_kgph: 9000,
    price_acs_usd: 150000000,
    engines: "PW4077 / GE90-77",
    required_runway_m: 3100
  },
  {
    manufacturer: "Boeing",
    model: "777-300",
    year: 1998,
    seats: 396,
    range_nm: 5000,
    speed_kts: 560,
    mtow_kg: 263000,
    fuel_burn_kgph: 11000,
    price_acs_usd: 180000000,
    engines: "GE90-92B",
    required_runway_m: 3100
  },

  // 2000s
  {
    manufacturer: "Airbus",
    model: "A318",
    year: 2003,
    seats: 110,
    range_nm: 3100,
    speed_kts: 480,
    mtow_kg: 68000,
    fuel_burn_kgph: 2600,
    price_acs_usd: 59000000,
    engines: "CFM56-5B",
    required_runway_m: 1850
  },

  // 1990s
  {
    manufacturer: "Airbus",
    model: "A319",
    year: 1996,
    seats: 124,
    range_nm: 3750,
    speed_kts: 480,
    mtow_kg: 75500,
    fuel_burn_kgph: 2700,
    price_acs_usd: 72000000,
    engines: "CFM56-5B",
    required_runway_m: 1900
  },

  // 1980s
  {
    manufacturer: "Airbus",
    model: "A320",
    year: 1988,
    seats: 150,
    range_nm: 3300,
    speed_kts: 480,
    mtow_kg: 77000,
    fuel_burn_kgph: 2900,
    price_acs_usd: 80000000,
    engines: "CFM56-5B",
    required_runway_m: 1900
  },

  // 1990s
  {
    manufacturer: "Airbus",
    model: "A321",
    year: 1994,
    seats: 185,
    range_nm: 3200,
    speed_kts: 480,
    mtow_kg: 89000,
    fuel_burn_kgph: 3100,
    price_acs_usd: 95000000,
    engines: "CFM56-5B",
    required_runway_m: 2050
  },
  {
    manufacturer: "Airbus",
    model: "A330-200",
    year: 1998,
    seats: 246,
    range_nm: 6750,
    speed_kts: 517,
    mtow_kg: 230000,
    fuel_burn_kgph: 8600,
    price_acs_usd: 185000000,
    engines: "Trent 700",
    required_runway_m: 3000
  },
  {
    manufacturer: "Airbus",
    model: "A330-300",
    year: 1993,
    seats: 295,
    range_nm: 6350,
    speed_kts: 517,
    mtow_kg: 242000,
    fuel_burn_kgph: 9000,
    price_acs_usd: 200000000,
    engines: "Trent 700",
    required_runway_m: 3000
  },
  {
    manufacturer: "McDonnell Douglas",
    model: "MD-11",
    year: 1990,
    seats: 285,
    range_nm: 6400,
    speed_kts: 520,
    mtow_kg: 285000,
    fuel_burn_kgph: 10200,
    price_acs_usd: 135000000,
    engines: "GE CF6-80C2",
    required_runway_m: 3450
  },
  {
    manufacturer: "Bombardier",
    model: "CRJ100",
    year: 1992,
    seats: 50,
    range_nm: 1500,
    speed_kts: 450,
    mtow_kg: 21500,
    fuel_burn_kgph: 1600,
    price_acs_usd: 24000000,
    engines: "GE CF34-3A1",
    required_runway_m: 1300
  },
  {
    manufacturer: "Bombardier",
    model: "CRJ200",
    year: 1996,
    seats: 50,
    range_nm: 1600,
    speed_kts: 450,
    mtow_kg: 24000,
    fuel_burn_kgph: 1650,
    price_acs_usd: 27000000,
    engines: "GE CF34-3B1",
    required_runway_m: 1300
  },
  {
    manufacturer: "Bombardier",
    model: "CRJ700",
    year: 1999,
    seats: 70,
    range_nm: 1700,
    speed_kts: 470,
    mtow_kg: 35000,
    fuel_burn_kgph: 2100,
    price_acs_usd: 32000000,
    engines: "GE CF34-8C1",
    required_runway_m: 1450
  },

  // 2000s
  {
    manufacturer: "Bombardier",
    model: "CRJ900",
    year: 2001,
    seats: 90,
    range_nm: 1550,
    speed_kts: 470,
    mtow_kg: 38500,
    fuel_burn_kgph: 2300,
    price_acs_usd: 38000000,
    engines: "GE CF34-8C5",
    required_runway_m: 1500
  },
  {
    manufacturer: "Bombardier",
    model: "Dash 8 Q400",
    year: 2000,
    seats: 78,
    range_nm: 1100,
    speed_kts: 360,
    mtow_kg: 29000,
    fuel_burn_kgph: 1500,
    price_acs_usd: 34000000,
    engines: "PW150A",
    required_runway_m: 1350
  },

  // 1990s
  {
    manufacturer: "ATR",
    model: "ATR 42-500",
    year: 1995,
    seats: 48,
    range_nm: 800,
    speed_kts: 300,
    mtow_kg: 18500,
    fuel_burn_kgph: 1200,
    price_acs_usd: 18000000,
    engines: "PW120",
    required_runway_m: 1150
  },
  {
    manufacturer: "ATR",
    model: "ATR 72-500",
    year: 1997,
    seats: 70,
    range_nm: 900,
    speed_kts: 300,
    mtow_kg: 22500,
    fuel_burn_kgph: 1300,
    price_acs_usd: 24000000,
    engines: "PW127",
    required_runway_m: 1250
  },
  {
    manufacturer: "Embraer",
    model: "ERJ-135",
    year: 1999,
    seats: 37,
    range_nm: 1550,
    speed_kts: 430,
    mtow_kg: 20500,
    fuel_burn_kgph: 1500,
    price_acs_usd: 21000000,
    engines: "RR AE3007",
    required_runway_m: 1250
  },
  {
    manufacturer: "Embraer",
    model: "ERJ-145",
    year: 1996,
    seats: 50,
    range_nm: 1550,
    speed_kts: 430,
    mtow_kg: 22500,
    fuel_burn_kgph: 1600,
    price_acs_usd: 24000000,
    engines: "RR AE3007",
    required_runway_m: 1300
  },

  // 2000s
  {
    manufacturer: "Embraer",
    model: "E170",
    year: 2004,
    seats: 78,
    range_nm: 2100,
    speed_kts: 470,
    mtow_kg: 39000,
    fuel_burn_kgph: 2400,
    price_acs_usd: 38000000,
    engines: "GE CF34-8E",
    required_runway_m: 1500
  },
  {
    manufacturer: "Embraer",
    model: "E190",
    year: 2005,
    seats: 98,
    range_nm: 2400,
    speed_kts: 470,
    mtow_kg: 51800,
    fuel_burn_kgph: 2600,
    price_acs_usd: 45000000,
    engines: "GE CF34-10E",
    required_runway_m: 1700
  },

  // 1980s
  {
    manufacturer: "Tupolev",
    model: "Tu-204",
    year: 1989,
    seats: 164,
    range_nm: 2100,
    speed_kts: 470,
    mtow_kg: 103000,
    fuel_burn_kgph: 5200,
    price_acs_usd: 35000000,
    engines: "PS-90A",
    required_runway_m: 2500
  },

  // 1990s
  {
    manufacturer: "Ilyushin",
    model: "Il-96-300",
    year: 1993,
    seats: 262,
    range_nm: 5100,
    speed_kts: 480,
    mtow_kg: 250000,
    fuel_burn_kgph: 10500,
    price_acs_usd: 85000000,
    engines: "PS-90A",
    required_runway_m: 3050
  },

  // 2010s
  {
    manufacturer: "Airbus",
    model: "A320neo",
    year: 2016,
    seats: 150,
    range_nm: 3500,
    speed_kts: 450,
    mtow_kg: 79000,
    fuel_burn_kgph: 2100,
    price_acs_usd: 49500000,
    engines: "PW1127G-JM / LEAP-1A",
    required_runway_m: 1800
  },
  {
    manufacturer: "Airbus",
    model: "A321neo",
    year: 2017,
    seats: 185,
    range_nm: 3500,
    speed_kts: 450,
    mtow_kg: 89000,
    fuel_burn_kgph: 2300,
    price_acs_usd: 56500000,
    engines: "PW1130G-JM / LEAP-1A",
    required_runway_m: 1900
  },
  {
    manufacturer: "Airbus",
    model: "A321LR",
    year: 2018,
    seats: 180,
    range_nm: 4000,
    speed_kts: 450,
    mtow_kg: 97000,
    fuel_burn_kgph: 2400,
    price_acs_usd: 61000000,
    engines: "LEAP-1A32",
    required_runway_m: 2100
  },

  // 2020s
  {
    manufacturer: "Airbus",
    model: "A321XLR",
    year: 2023,
    seats: 180,
    range_nm: 4700,
    speed_kts: 450,
    mtow_kg: 101000,
    fuel_burn_kgph: 2350,
    price_acs_usd: 68500000,
    engines: "LEAP-1A35",
    required_runway_m: 2500
  },

  // 2010s
  {
    manufacturer: "Airbus",
    model: "A350-900",
    year: 2015,
    seats: 325,
    range_nm: 8100,
    speed_kts: 488,
    mtow_kg: 280000,
    fuel_burn_kgph: 8400,
    price_acs_usd: 317000000,
    engines: "RR Trent XWB-84",
    required_runway_m: 3000
  },
  {
    manufacturer: "Airbus",
    model: "A350-900 ULR",
    year: 2018,
    seats: 170,
    range_nm: 9700,
    speed_kts: 488,
    mtow_kg: 280000,
    fuel_burn_kgph: 8400,
    price_acs_usd: 340000000,
    engines: "RR Trent XWB-84",
    required_runway_m: 3000
  },
  {
    manufacturer: "Airbus",
    model: "A350-1000",
    year: 2018,
    seats: 366,
    range_nm: 8000,
    speed_kts: 488,
    mtow_kg: 308000,
    fuel_burn_kgph: 8950,
    price_acs_usd: 366000000,
    engines: "RR Trent XWB-97",
    required_runway_m: 3000
  },

  // 2020s
  {
    manufacturer: "Airbus",
    model: "A330-800neo",
    year: 2020,
    seats: 257,
    range_nm: 7500,
    speed_kts: 475,
    mtow_kg: 251000,
    fuel_burn_kgph: 6600,
    price_acs_usd: 131000000,
    engines: "RR Trent 7000",
    required_runway_m: 3050
  },

  // 2010s
  {
    manufacturer: "Airbus",
    model: "A330-900neo",
    year: 2018,
    seats: 287,
    range_nm: 6550,
    speed_kts: 475,
    mtow_kg: 251000,
    fuel_burn_kgph: 6800,
    price_acs_usd: 131000000,
    engines: "RR Trent 7000",
    required_runway_m: 3050
  },
  {
    manufacturer: "Airbus",
    model: "A220-100",
    year: 2016,
    seats: 110,
    range_nm: 3100,
    speed_kts: 450,
    mtow_kg: 60000,
    fuel_burn_kgph: 1600,
    price_acs_usd: 82000000,
    engines: "PW1500G",
    required_runway_m: 1650
  },
  {
    manufacturer: "Airbus",
    model: "A220-300",
    year: 2017,
    seats: 145,
    range_nm: 3300,
    speed_kts: 450,
    mtow_kg: 69000,
    fuel_burn_kgph: 1700,
    price_acs_usd: 89000000,
    engines: "PW1500G",
    required_runway_m: 1750
  },

  // 2020s
  {
    manufacturer: "Airbus",
    model: "A220-500",
    year: 2026,
    seats: 175,
    range_nm: 3100,
    speed_kts: 450,
    mtow_kg: 72000,
    fuel_burn_kgph: 1800,
    price_acs_usd: 98000000,
    engines: "PW1500G",
    required_runway_m: 1750
  },

  // 2010s
  {
    manufacturer: "Boeing",
    model: "737 MAX 7",
    year: 2017,
    seats: 138,
    range_nm: 3850,
    speed_kts: 470,
    mtow_kg: 80100,
    fuel_burn_kgph: 2050,
    price_acs_usd: 61500000,
    engines: "LEAP-1B",
    required_runway_m: 2000
  },
  {
    manufacturer: "Boeing",
    model: "737 MAX 8",
    year: 2017,
    seats: 162,
    range_nm: 3550,
    speed_kts: 470,
    mtow_kg: 82000,
    fuel_burn_kgph: 2150,
    price_acs_usd: 65500000,
    engines: "LEAP-1B",
    required_runway_m: 2000
  },
  {
    manufacturer: "Boeing",
    model: "737 MAX 9",
    year: 2018,
    seats: 180,
    range_nm: 3500,
    speed_kts: 470,
    mtow_kg: 88000,
    fuel_burn_kgph: 2200,
    price_acs_usd: 70000000,
    engines: "LEAP-1B",
    required_runway_m: 2050
  },

  // 2020s
  {
    manufacturer: "Boeing",
    model: "737 MAX 10",
    year: 2023,
    seats: 204,
    range_nm: 3300,
    speed_kts: 470,
    mtow_kg: 89200,
    fuel_burn_kgph: 2250,
    price_acs_usd: 75000000,
    engines: "LEAP-1B",
    required_runway_m: 2050
  },

  // 2010s
  {
    manufacturer: "Boeing",
    model: "787-8 Dreamliner",
    year: 2012,
    seats: 248,
    range_nm: 7635,
    speed_kts: 488,
    mtow_kg: 228000,
    fuel_burn_kgph: 6200,
    price_acs_usd: 227000000,
    engines: "GEnx-1B",
    required_runway_m: 2900
  },
  {
    manufacturer: "Boeing",
    model: "787-9 Dreamliner",
    year: 2014,
    seats: 296,
    range_nm: 7635,
    speed_kts: 488,
    mtow_kg: 254000,
    fuel_burn_kgph: 6800,
    price_acs_usd: 264000000,
    engines: "GEnx-1B",
    required_runway_m: 2900
  },
  {
    manufacturer: "Boeing",
    model: "787-10 Dreamliner",
    year: 2018,
    seats: 336,
    range_nm: 6430,
    speed_kts: 488,
    mtow_kg: 254000,
    fuel_burn_kgph: 7100,
    price_acs_usd: 306000000,
    engines: "GEnx-1B",
    required_runway_m: 2900
  },

  // 2020s
  {
    manufacturer: "Boeing",
    model: "787-9 (2025 Update)",
    year: 2025,
    seats: 296,
    range_nm: 7635,
    speed_kts: 488,
    mtow_kg: 254000,
    fuel_burn_kgph: 6500,
    price_acs_usd: 278000000,
    engines: "GEnx-1B (PIP)",
    required_runway_m: 2900
  },

  // 2010s
  {
    manufacturer: "Embraer",
    model: "E190-E2",
    year: 2018,
    seats: 110,
    range_nm: 2850,
    speed_kts: 455,
    mtow_kg: 56500,
    fuel_burn_kgph: 1550,
    price_acs_usd: 60000000,
    engines: "PW1900G",
    required_runway_m: 1750
  },
  {
    manufacturer: "Embraer",
    model: "E195-E2",
    year: 2019,
    seats: 132,
    range_nm: 2600,
    speed_kts: 455,
    mtow_kg: 62000,
    fuel_burn_kgph: 1650,
    price_acs_usd: 67000000,
    engines: "PW1900G",
    required_runway_m: 1800
  },

  // 2020s
  {
    manufacturer: "Embraer",
    model: "E175-E2",
    year: 2020,
    seats: 88,
    range_nm: 2200,
    speed_kts: 455,
    mtow_kg: 41700,
    fuel_burn_kgph: 1350,
    price_acs_usd: 48000000,
    engines: "PW1715G",
    required_runway_m: 1600
  },

  // 2000s
  {
    manufacturer: "Bombardier",
    model: "Q400 (Dash 8-400)",
    year: 2000,
    seats: 78,
    range_nm: 1100,
    speed_kts: 360,
    mtow_kg: 29000,
    fuel_burn_kgph: 900,
    price_acs_usd: 33500000,
    engines: "PW150A",
    required_runway_m: 1350
  },

  // 2010s
  {
    manufacturer: "ATR",
    model: "ATR 72-600",
    year: 2010,
    seats: 72,
    range_nm: 825,
    speed_kts: 276,
    mtow_kg: 23000,
    fuel_burn_kgph: 780,
    price_acs_usd: 21500000,
    engines: "PW127M",
    required_runway_m: 1250
  },

  // 2020s
  {
    manufacturer: "ATR",
    model: "ATR 72-600 EVO",
    year: 2024,
    seats: 74,
    range_nm: 850,
    speed_kts: 276,
    mtow_kg: 23500,
    fuel_burn_kgph: 720,
    price_acs_usd: 24500000,
    engines: "PW127XT-L",
    required_runway_m: 1250
  },
  {
    manufacturer: "ATR",
    model: "ATR 42-600S (STOL)",
    year: 2025,
    seats: 48,
    range_nm: 750,
    speed_kts: 265,
    mtow_kg: 19500,
    fuel_burn_kgph: 690,
    price_acs_usd: 22500000,
    engines: "PW127XT-S",
    required_runway_m: 1150
  },
  {
    manufacturer: "Sukhoi",
    model: "SSJ100-NEW",
    year: 2021,
    seats: 98,
    range_nm: 2100,
    speed_kts: 450,
    mtow_kg: 48500,
    fuel_burn_kgph: 1650,
    price_acs_usd: 38000000,
    engines: "PD-8",
    required_runway_m: 1650
  },
  {
    manufacturer: "Yakovlev",
    model: "MC-21-300",
    year: 2024,
    seats: 163,
    range_nm: 3000,
    speed_kts: 450,
    mtow_kg: 79000,
    fuel_burn_kgph: 2100,
    price_acs_usd: 65000000,
    engines: "PD-14 / PW1400G",
    required_runway_m: 2000
  },
  {
    manufacturer: "Yakovlev",
    model: "MC-21-200",
    year: 2025,
    seats: 132,
    range_nm: 3300,
    speed_kts: 450,
    mtow_kg: 72000,
    fuel_burn_kgph: 1800,
    price_acs_usd: 60000000,
    engines: "PD-14",
    required_runway_m: 1850
  },

  // 2010s
  {
    manufacturer: "COMAC",
    model: "ARJ21-700",
    year: 2016,
    seats: 95,
    range_nm: 1200,
    speed_kts: 450,
    mtow_kg: 40500,
    fuel_burn_kgph: 2000,
    price_acs_usd: 38000000,
    engines: "GE CF34-10A",
    required_runway_m: 1500
  },

  // 2020s
  {
    manufacturer: "COMAC",
    model: "C919",
    year: 2021,
    seats: 158,
    range_nm: 2550,
    speed_kts: 450,
    mtow_kg: 72500,
    fuel_burn_kgph: 2300,
    price_acs_usd: 65000000,
    engines: "LEAP-1C",
    required_runway_m: 1850
  },

];
