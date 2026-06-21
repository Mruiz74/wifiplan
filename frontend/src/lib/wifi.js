// Modelo de cobertura WiFi de WIFIPlan (reemplaza al DORI de CCTVPLAN).
// Heatmap de señal (RSSI) por banda, con atenuación por MATERIAL de muro y
// potencia ajustable por AP. Modelo log-distancia (n≈3 interior).

const N = 3; // exponente de pérdida (interior con obstáculos)

// Bandas disponibles según la generación WiFi.
export const bandasPorWifi = (w) => (w === '6e' || w === '7' ? ['2.4', '5', '6'] : ['2.4', '5']);
export const NOMBRE_BANDA = { '2.4': '2.4 GHz', '5': '5 GHz', '6': '6 GHz' };

// Radio (m) hasta -67 dBm ("bueno") en interior, a potencia 100%.
const R67 = { '2.4': 18, '5': 12, '6': 9 };

// Anillos de calidad de señal, como múltiplo del radio a -67 dBm.
export const RINGS = [
  { key: 'regular', label: 'Regular −75 dBm', mult: 1.85, fill: 'rgba(245,158,11,0.10)' },
  { key: 'bueno', label: 'Bueno −67 dBm', mult: 1.0, fill: 'rgba(234,179,8,0.16)' },
  { key: 'muybueno', label: 'Muy bueno −60 dBm', mult: 0.58, fill: 'rgba(34,197,94,0.18)' },
  { key: 'excelente', label: 'Excelente −50 dBm', mult: 0.27, fill: 'rgba(34,197,94,0.34)' },
];

// Materiales de muro: atenuación (dB) de referencia a 5 GHz + color identificador.
export const MATERIALES = [
  { key: 'tabique', nombre: 'Tabique (yeso-cartón)', db: 3, color: '#94a3b8' },
  { key: 'madera', nombre: 'Madera', db: 4, color: '#b45309' },
  { key: 'vidrio', nombre: 'Vidrio común', db: 3, color: '#22d3ee' },
  { key: 'vidrio_low_e', nombre: 'Vidrio termopanel / Low-E', db: 10, color: '#0891b2' },
  { key: 'ladrillo', nombre: 'Ladrillo', db: 7, color: '#ea580c' },
  { key: 'hormigon', nombre: 'Hormigón armado', db: 14, color: '#475569' },
  { key: 'metal', nombre: 'Metal / estructura', db: 25, color: '#dc2626' },
];
export const MAT_DEFAULT = 'tabique';
const MAT_DB = Object.fromEntries(MATERIALES.map((m) => [m.key, m.db]));
const MAT_MAP = Object.fromEntries(MATERIALES.map((m) => [m.key, m]));
export const matColor = (key) => (MAT_MAP[key] || MAT_MAP[MAT_DEFAULT]).color;
export const matNombre = (key) => (MAT_MAP[key] || MAT_MAP[MAT_DEFAULT]).nombre;

// La atenuación empeora en bandas altas (2.4 penetra mejor que 5 y 6 GHz).
const BANDA_FACTOR = { '2.4': 0.65, '5': 1.0, '6': 1.2 };
export function atenuacionMuro(material, banda) {
  return (MAT_DB[material] ?? MAT_DB[MAT_DEFAULT]) * (BANDA_FACTOR[banda] || 1);
}

// Canales no solapados sugeridos por banda (para evitar co-canal entre APs).
export const CANALES = {
  '2.4': [1, 6, 11],
  '5': [36, 40, 44, 48, 149, 153, 157, 161],
  '6': [37, 53, 69, 85, 101, 117, 133, 149],
};
// Canal sugerido rotando entre los no solapados (por índice de AP en esa banda).
export const canalSugerido = (banda, idx) => {
  const c = CANALES[banda] || CANALES['5'];
  return c[idx % c.length];
};

// Factor de radio por potencia (%, 30–100). 100% = nominal.
export const factorPotencia = (pct) => Math.pow(Math.max(20, Math.min(100, pct || 100)) / 100, 1 / N);

// Cobertura de un AP en una banda: radios (m) por anillo, ajustada por potencia.
export function coberturaWifi(ap, banda, potenciaPct) {
  const cls = ap.outdoor ? 1.7 : ap.segmento === 'enterprise' ? 1.1 : 1.0;
  const r67 = (R67[banda] || R67['5']) * cls * factorPotencia(potenciaPct);
  return { banda, r67_m: r67, rings: RINGS.map((b) => ({ ...b, r_m: r67 * b.mult })) };
}

// Radio efectivo (m) tras atravesar muros que suman 'sumDB' dB de atenuación.
export const radioEfectivo = (r_m, sumDB) => r_m * Math.pow(10, -sumDB / (10 * N));
