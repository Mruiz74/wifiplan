import { useEffect, useRef, useState } from 'react'
import catalogo from './data/aps.json'
import dispositivos from './data/dispositivos.json'
import { coberturaWifi, RINGS, bandasPorWifi, atenuacionMuro, radioEfectivo, MAT_DEFAULT, MATERIALES, matColor, matNombre, NOMBRE_BANDA, CANALES, canalSugerido } from './lib/wifi'
import { raySeg, dist, clamp } from './geom'
import { abrirPropuesta } from './proposal'

const CAMS = catalogo.aps
const DEVS = dispositivos.dispositivos
// APs del usuario (importados), persistidos en localStorage.
let CUSTOM = (() => { try { return JSON.parse(localStorage.getItem('wifiplan_aps') || '[]') } catch { return [] } })()
const catById = (id) => CAMS.find((c) => c.id === id) || CUSTOM.find((c) => c.id === id)
const devById = (id) => DEVS.find((d) => d.id === id)
const MARCAS = [...new Set(CAMS.map((c) => c.marca))]
export const clp = (n) => '$' + (Math.round(Number(n) || 0)).toLocaleString('es-CL')
const API_IA = 'https://wifiplan-api.onrender.com'

const BANDAS = RINGS // anillos de señal (para la leyenda y el heatmap)

const STORE = 'wifiplan_project'
const pisoVacio = (n) => ({ id: 'f' + Math.random().toString(36).slice(2, 8), nombre: 'Piso ' + n, bg: null, pxPerMeter: null, cameras: [], devices: [], walls: [], cables: [] })
const nuevoProyecto = () => ({ nombre: 'Proyecto sin nombre', cliente: '', bg: null, pxPerMeter: null, cameras: [], devices: [], walls: [], cables: [], precios: {}, precioCableM: 0, extras: [], rec: { fps: 15, codec: 'h265', dias: 14, factor: 1 }, pisoActivo: 0, pisos: [pisoVacio(1)] })

// El piso activo se trabaja en los campos de nivel superior (bg, cameras, walls…);
// commitPiso guarda esos campos dentro de pisos[pisoActivo] (para BOM, guardar, cambiar de piso).
function commitPiso(p) {
  if (!p.pisos) return p
  const pisos = p.pisos.map((pi, i) => (i === p.pisoActivo
    ? { ...pi, bg: p.bg, pxPerMeter: p.pxPerMeter, cameras: p.cameras, devices: p.devices, walls: p.walls, cables: p.cables }
    : pi))
  return { ...p, pisos }
}
// Migra proyectos antiguos (sin pisos) a un único "Piso 1".
function migrarPisos(p) {
  if (p.pisos && p.pisos.length) return { ...p, pisoActivo: p.pisoActivo || 0 }
  return { ...p, pisoActivo: 0, pisos: [{ ...pisoVacio(1), bg: p.bg || null, pxPerMeter: p.pxPerMeter || null, cameras: p.cameras || [], devices: p.devices || [], walls: p.walls || [], cables: p.cables || [] }] }
}

// Dimensionamiento de la red WiFi: APs, consumo PoE, switch y controladora.
function calcSistema(proj) {
  const aps = (commitPiso(proj).pisos || []).flatMap((f) => f.cameras || [])
  const nAP = aps.length
  let watts = 0
  for (const a of aps) { const cat = catById(a.catId); if (!cat) continue; watts += cat.segmento === 'enterprise' ? 25 : cat.outdoor ? 22 : 15 }
  const puertos = [8, 16, 24, 48].find((n) => n >= nAP) || Math.ceil(nAP / 24) * 24
  const ctrl = aps.some((a) => { const c = catById(a.catId); return c && (c.licencia === 'requerida' || c.licencia === 'anual') })
  return { nAP, watts, puertos, ctrl }
}

export default function App() {
  const [proj, setProj] = useState(() => {
    try { return migrarPisos({ ...nuevoProyecto(), ...JSON.parse(localStorage.getItem(STORE)) }) } catch { return nuevoProyecto() }
  })
  const [mode, setMode] = useState('select') // select | scale | wall | cable | camera | device
  const [catTab, setCatTab] = useState('camaras')
  const [catSel, setCatSel] = useState(null)
  const [devSel, setDevSel] = useState(null)
  const [sel, setSel] = useState(null) // { kind:'cam'|'dev', id }
  const [view, setView] = useState({ zoom: 1, tx: 0, ty: 0 })
  const [scalePts, setScalePts] = useState([])
  const [lineStart, setLineStart] = useState(null) // muro o cable en curso
  const [marca, setMarca] = useState(MARCAS[0])
  const [matSel, setMatSel] = useState(MAT_DEFAULT) // material para dibujar muros
  const [autoPts, setAutoPts] = useState([])
  const [autoNivel, setAutoNivel] = useState('reconocer')
  const [iaBrief, setIaBrief] = useState('')
  const [iaMarca, setIaMarca] = useState('auto')
  const [iaLoading, setIaLoading] = useState(false)
  const [iaResult, setIaResult] = useState(null)
  const [iaErr, setIaErr] = useState('')
  const [murosLoading, setMurosLoading] = useState(false)
  const [dxf, setDxf] = useState(null) // { data, sel:Set } — selector de capas DXF
  const [sat, setSat] = useState(null) // { dir, metros, loading, err } — modal satélite
  const [customCams, setCustomCams] = useState(CUSTOM)
  const [dsLoading, setDsLoading] = useState(false)
  const [dsResult, setDsResult] = useState(null) // cámara leída del datasheet, pendiente de confirmar
  const [auth, setAuth] = useState(() => { try { return JSON.parse(localStorage.getItem('wifiplan_auth') || 'null') } catch { return null } })
  const [cloud, setCloud] = useState(null) // modal proyectos en la nube
  const [cloudId, setCloudId] = useState(null) // id del proyecto abierto en la nube
  const [empresa, setEmpresa] = useState(() => { try { return JSON.parse(localStorage.getItem('wifiplan_empresa') || '{}') } catch { return {} } })
  const [marcaModal, setMarcaModal] = useState(false)
  const svgRef = useRef(null)
  const drag = useRef(null)
  const projRef = useRef(proj)
  const hist = useRef({ past: [], future: [] })

  useEffect(() => {
    projRef.current = proj
    try { localStorage.setItem(STORE, JSON.stringify(commitPiso(proj))) }
    catch { /* plano muy grande para guardar local: el proyecto sigue en memoria */ }
  }, [proj])

  useEffect(() => {
    CUSTOM = customCams // para que catById (módulo) encuentre las del usuario
    try { localStorage.setItem('wifiplan_aps', JSON.stringify(customCams)) } catch { /* */ }
  }, [customCams])

  useEffect(() => { try { localStorage.setItem('wifiplan_empresa', JSON.stringify(empresa)) } catch { /* */ } }, [empresa])

  const subirLogo = (file) => {
    if (!file) return
    const r = new FileReader()
    r.onload = () => setEmpresa((e) => ({ ...e, logo: r.result }))
    r.readAsDataURL(file)
  }

  // Historial (deshacer/rehacer)
  const snapshot = () => { const h = hist.current; h.past.push(JSON.stringify(projRef.current)); if (h.past.length > 40) h.past.shift(); h.future = [] }
  const undo = () => { const h = hist.current; if (!h.past.length) return; h.future.push(JSON.stringify(projRef.current)); setProj(JSON.parse(h.past.pop())); setSel(null) }
  const redo = () => { const h = hist.current; if (!h.future.length) return; h.past.push(JSON.stringify(projRef.current)); setProj(JSON.parse(h.future.pop())); setSel(null) }

  useEffect(() => {
    const onKey = (e) => {
      const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !editing) {
        snapshot()
        if (sel.kind === 'cam') setProj((p) => ({ ...p, cameras: p.cameras.filter((c) => c.id !== sel.id) }))
        else setProj((p) => ({ ...p, devices: p.devices.filter((d) => d.id !== sel.id) }))
        setSel(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sel])

  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const sx = e.clientX - r.left, sy = e.clientY - r.top
      setView((v) => {
        const f = e.deltaY < 0 ? 1.12 : 1 / 1.12
        const nz = clamp(v.zoom * f, 0.05, 30)
        return { zoom: nz, tx: sx - ((sx - v.tx) / v.zoom) * nz, ty: sy - ((sy - v.ty) / v.zoom) * nz }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const toWorld = (cx, cy) => {
    const r = svgRef.current.getBoundingClientRect()
    return { x: (cx - r.left - view.tx) / view.zoom, y: (cy - r.top - view.ty) / view.zoom }
  }
  const set = (patch) => setProj((p) => ({ ...p, ...patch }))

  const fitView = (bg = proj.bg) => {
    if (!bg || !svgRef.current) return
    const r = svgRef.current.getBoundingClientRect()
    const z = Math.min(r.width / bg.w, r.height / bg.h) * 0.9
    setView({ zoom: z, tx: (r.width - bg.w * z) / 2, ty: (r.height - bg.h * z) / 2 })
  }

  // ---------- Pisos / niveles ----------
  const cargarPiso = (committed, idx) => {
    const f = committed.pisos[idx]
    return { ...committed, pisoActivo: idx, bg: f.bg, pxPerMeter: f.pxPerMeter, cameras: f.cameras, devices: f.devices, walls: f.walls, cables: f.cables }
  }
  const cambiarPiso = (idx) => {
    if (idx === proj.pisoActivo) return
    snapshot()
    const committed = commitPiso(proj)
    setProj(cargarPiso(committed, idx)); setSel(null); setMode('select')
    fitView(committed.pisos[idx].bg)
  }
  const agregarPiso = () => {
    snapshot()
    const committed = commitPiso(proj)
    const nuevo = pisoVacio(committed.pisos.length + 1)
    setProj({ ...committed, pisos: [...committed.pisos, nuevo], pisoActivo: committed.pisos.length, bg: null, pxPerMeter: null, cameras: [], devices: [], walls: [], cables: [] })
    setSel(null); setMode('select')
  }
  const borrarPiso = (idx) => {
    if (proj.pisos.length <= 1) { alert('Debe quedar al menos un piso.'); return }
    if (!confirm('¿Borrar "' + (proj.pisos[idx]?.nombre || 'piso') + '" y todo su contenido?')) return
    snapshot()
    const committed = commitPiso(proj)
    const pisos = committed.pisos.filter((_, i) => i !== idx)
    const act = committed.pisoActivo > idx ? committed.pisoActivo - 1 : Math.min(committed.pisoActivo, pisos.length - 1)
    setProj(cargarPiso({ ...committed, pisos }, act)); setSel(null)
    fitView(pisos[act].bg)
  }
  const renombrarActivo = () => {
    const nom = prompt('Nombre del piso:', proj.pisos[proj.pisoActivo]?.nombre || '')
    if (nom == null) return
    setProj((p) => ({ ...p, pisos: p.pisos.map((pi, i) => (i === p.pisoActivo ? { ...pi, nombre: nom.trim() || pi.nombre } : pi)) }))
  }

  const subirPlano = async (file) => {
    if (!file) return
    if (/\.dxf$/i.test(file.name)) {
      try {
        const txt = await file.text()
        const { parseDXF } = await import('./lib/dxf') // se carga solo al usar DXF
        const res = parseDXF(txt)
        const pre = res.layers.filter((l) => /muro|wall|constru|cierro|tabique|perimetr|edific/i.test(l.name)).map((l) => l.name)
        setProj((p) => ({ ...p, bg: { url: '', w: res.w, h: res.h }, pxPerMeter: res.pxPerMeter || p.pxPerMeter }))
        fitView({ w: res.w, h: res.h })
        setDxf({ data: res, sel: new Set(pre) })
      } catch (e) { console.error(e); alert(e.message || 'No se pudo leer el DXF') }
      return
    }
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      try {
        const buf = await file.arrayBuffer()
        const { pdfABackground } = await import('./lib/pdf') // se carga solo al usar PDF
        const bg = await pdfABackground(buf)
        set({ bg }); fitView(bg)
      } catch (e) { console.error(e); alert('No se pudo leer el PDF. Prueba con otra página o una imagen.') }
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => { const bg = { url: reader.result, w: img.naturalWidth, h: img.naturalHeight }; set({ bg }); fitView(bg) }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  }

  const onPointerDown = (e) => {
    const w = toWorld(e.clientX, e.clientY)
    if (mode === 'camera' || mode === 'device' || mode === 'wall' || mode === 'cable' || (mode === 'rect' && lineStart) || (mode === 'scale' && scalePts.length === 1)) snapshot()
    if (mode === 'camera' && catSel) {
      const cat = catById(catSel)
      const bs = cat ? bandasPorWifi(cat.wifi) : ['5']
      const banda = bs.includes('5') ? '5' : bs[0]
      const id = 'ap' + Date.now()
      set({ cameras: [...proj.cameras, { id, catId: catSel, banda, potencia: 100, canal: canalSugerido(banda, proj.cameras.length), x: w.x, y: w.y }] })
      setSel({ kind: 'cam', id }); setMode('select'); return
    }
    if (mode === 'device' && devSel) {
      const id = 'd' + Date.now()
      set({ devices: [...proj.devices, { id, devId: devSel, x: w.x, y: w.y }] })
      setSel({ kind: 'dev', id }); setMode('select'); return
    }
    if (mode === 'scale') {
      const pts = [...scalePts, w]
      if (pts.length === 2) {
        const px = dist(pts[0].x, pts[0].y, pts[1].x, pts[1].y)
        const m = parseFloat(prompt('¿Cuántos METROS mide esa distancia en la realidad?', '5'))
        if (m > 0) set({ pxPerMeter: px / m })
        setScalePts([]); setMode('select')
      } else setScalePts(pts)
      return
    }
    if (mode === 'wall' || mode === 'cable') {
      const arr = mode === 'wall' ? 'walls' : 'cables'
      if (!lineStart) setLineStart(w)
      else {
        const seg = { x1: lineStart.x, y1: lineStart.y, x2: w.x, y2: w.y }
        if (mode === 'wall') seg.mat = matSel
        set({ [arr]: [...proj[arr], seg] }); setLineStart(w)
      }
      return
    }
    if (mode === 'rect') {
      if (!lineStart) setLineStart(w)
      else {
        const ax = Math.min(lineStart.x, w.x), ay = Math.min(lineStart.y, w.y), bx = Math.max(lineStart.x, w.x), by = Math.max(lineStart.y, w.y)
        set({ walls: [...proj.walls,
          { x1: ax, y1: ay, x2: bx, y2: ay, mat: matSel },
          { x1: bx, y1: ay, x2: bx, y2: by, mat: matSel },
          { x1: bx, y1: by, x2: ax, y2: by, mat: matSel },
          { x1: ax, y1: by, x2: ax, y2: ay, mat: matSel },
        ] })
        setLineStart(null)
      }
      return
    }
    if (mode === 'auto') { setAutoPts((a) => [...a, w]); return }
    setSel(null)
    drag.current = { type: 'pan', sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const onMove = (e) => {
    const d = drag.current
    if (!d) return
    if (d.type === 'pan') setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.sx), ty: d.ty + (e.clientY - d.sy) }))
    else if (d.type === 'cam') { const w = toWorld(e.clientX, e.clientY); setProj((p) => ({ ...p, cameras: p.cameras.map((c) => (c.id === d.id ? { ...c, x: w.x - d.ox, y: w.y - d.oy } : c)) })) }
    else if (d.type === 'rot') { const w = toWorld(e.clientX, e.clientY); const ang = Math.round((((Math.atan2(w.y - d.cy, w.x - d.cx) * 180) / Math.PI) % 360 + 360) % 360); setProj((p) => ({ ...p, cameras: p.cameras.map((c) => (c.id === d.id ? { ...c, rot: ang } : c)) })) }
    else if (d.type === 'dev') { const w = toWorld(e.clientX, e.clientY); setProj((p) => ({ ...p, devices: p.devices.map((c) => (c.id === d.id ? { ...c, x: w.x - d.ox, y: w.y - d.oy } : c)) })) }
  }
  const onUp = () => { drag.current = null; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }

  const startDrag = (e, kind, item) => {
    e.stopPropagation()
    if (mode !== 'select') return
    snapshot()
    setSel({ kind, id: item.id })
    const w = toWorld(e.clientX, e.clientY)
    drag.current = { type: kind, id: item.id, ox: w.x - item.x, oy: w.y - item.y }
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp)
  }

  const startRot = (e, cam) => {
    e.stopPropagation()
    snapshot()
    setSel({ kind: 'cam', id: cam.id })
    drag.current = { type: 'rot', id: cam.id, cx: cam.x, cy: cam.y }
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp)
  }

  const updCam = (id, patch) => setProj((p) => ({ ...p, cameras: p.cameras.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))
  const delSel = () => {
    if (!sel) return
    snapshot()
    if (sel.kind === 'cam') setProj((p) => ({ ...p, cameras: p.cameras.filter((c) => c.id !== sel.id) }))
    else setProj((p) => ({ ...p, devices: p.devices.filter((d) => d.id !== sel.id) }))
    setSel(null)
  }
  const deshacerLinea = (arr) => setProj((p) => ({ ...p, [arr]: p[arr].slice(0, -1) }))
  const borrarMuro = (i) => { snapshot(); setProj((p) => ({ ...p, walls: p.walls.filter((_, k) => k !== i) })) }

  const toggleCapa = (name) => setDxf((d) => { const s = new Set(d.sel); s.has(name) ? s.delete(name) : s.add(name); return { ...d, sel: s } })
  const importarCapas = () => {
    if (!dxf) return
    const muros = dxf.data.segs.filter((s) => dxf.sel.has(s.layer)).map(({ x1, y1, x2, y2 }) => ({ x1, y1, x2, y2 }))
    snapshot(); setProj((p) => ({ ...p, walls: muros })); setDxf(null)
  }


  // Detección de murallas con IA: Claude lee el plano y devuelve los segmentos.
  const detectarMurosIA = async () => {
    if (!proj.bg) { alert('Sube un plano primero (📐).'); return }
    setMurosLoading(true)
    try {
      const r = await fetch(API_IA + '/api/muros', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imagenDataUrl: proj.bg.url }) })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Error del servidor de IA')
      const nuevos = []
      for (const z of (data.recintos || [])) {
        const x = (z.x || 0) * proj.bg.w, y = (z.y || 0) * proj.bg.h
        const w = (z.w || 0) * proj.bg.w, h = (z.h || 0) * proj.bg.h
        if (w < 6 || h < 6) continue
        nuevos.push(
          { x1: x, y1: y, x2: x + w, y2: y },
          { x1: x + w, y1: y, x2: x + w, y2: y + h },
          { x1: x + w, y1: y + h, x2: x, y2: y + h },
          { x1: x, y1: y + h, x2: x, y2: y },
        )
      }
      if (nuevos.length) { snapshot(); set({ walls: [...proj.walls, ...nuevos] }) }
      else alert('La IA no detectó recintos claros. Prueba con un plano más nítido o dibuja los muros a mano.')
    } catch (e) { alert(e.message || 'No se pudo detectar las murallas') } finally { setMurosLoading(false) }
  }

  // Trae una imagen satelital del sitio por dirección, ya calibrada a escala real.
  const buscarSatelite = async () => {
    const dir = (sat.dir || '').trim()
    if (!dir) { setSat((s) => ({ ...s, err: 'Escribe una dirección.' })); return }
    setSat((s) => ({ ...s, loading: true, err: '' }))
    try {
      const r = await fetch(API_IA + '/api/satelite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direccion: dir, metros: sat.metros, tipo: sat.tipo }) })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'No se pudo obtener la imagen')
      snapshot()
      setProj((p) => ({ ...p, bg: { url: data.imagen, w: data.w, h: data.h }, pxPerMeter: data.pxPerMeter }))
      fitView({ w: data.w, h: data.h })
      setSat(null)
    } catch (e) { setSat((s) => ({ ...s, loading: false, err: e.message || 'Error al traer la imagen' })) }
  }

  // ---------- Proyectos en la nube (login propio + Neon) ----------
  const guardarAuth = (a) => { setAuth(a); try { localStorage.setItem('wifiplan_auth', JSON.stringify(a)) } catch { /* */ } }
  const logout = () => { setAuth(null); setCloudId(null); localStorage.removeItem('wifiplan_auth'); setCloud((c) => ({ ...(c || {}), tab: 'login', list: [], err: '' })) }
  const apiAuth = (path, opts = {}) => fetch(API_IA + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth.token } : {}), ...(opts.headers || {}) } })

  const cargarLista = async () => {
    if (!auth) return
    try {
      const r = await apiAuth('/api/proyectos')
      if (r.status === 401) { logout(); return }
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Error')
      setCloud((c) => ({ ...(c || {}), list: data.proyectos || [], err: '' }))
    } catch (e) { setCloud((c) => ({ ...(c || {}), err: e.message || 'No se pudo cargar la lista' })) }
  }

  const doAuth = async () => {
    const reg = cloud.tab === 'register'
    setCloud((s) => ({ ...s, loading: true, err: '' }))
    try {
      const r = await fetch(API_IA + (reg ? '/api/register' : '/api/login'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre: cloud.nombre, email: cloud.email, password: cloud.password }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Error')
      guardarAuth({ token: data.token, user: data.user })
      setCloud((s) => ({ ...s, loading: false, err: '', password: '', tab: 'list' }))
      cargarLista()
    } catch (e) { setCloud((s) => ({ ...s, loading: false, err: e.message || 'Error' })) }
  }

  const guardarNube = async (forceNew) => {
    if (!auth) { setCloud({ tab: 'login', email: '', password: '', nombre: '', err: '', list: [] }); return }
    setCloud((c) => ({ ...(c || {}), saving: true, err: '', msg: '' }))
    try {
      const body = JSON.stringify({ nombre: proj.nombre, data: commitPiso(proj) })
      const useId = !forceNew && cloudId
      const r = useId ? await apiAuth('/api/proyectos/' + useId, { method: 'PUT', body }) : await apiAuth('/api/proyectos', { method: 'POST', body })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Error')
      setCloudId(data.proyecto.id)
      setCloud((c) => ({ ...(c || {}), saving: false, msg: 'Guardado en la nube ✓' }))
      cargarLista()
    } catch (e) { setCloud((c) => ({ ...(c || {}), saving: false, err: e.message || 'No se pudo guardar' })) }
  }

  const abrirNube = async (id) => {
    try {
      const r = await apiAuth('/api/proyectos/' + id)
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Error')
      hist.current = { past: [], future: [] }
      const d = data.proyecto.data || {}
      const mig = migrarPisos({ ...nuevoProyecto(), ...d, nombre: data.proyecto.nombre })
      setProj(mig)
      setCloudId(id); setSel(null); setCloud(null)
      fitView(mig.bg)
    } catch (e) { setCloud((c) => ({ ...(c || {}), err: e.message || 'No se pudo abrir' })) }
  }

  const borrarNube = async (id) => {
    if (!confirm('¿Borrar este proyecto de la nube? No se puede deshacer.')) return
    try {
      const r = await apiAuth('/api/proyectos/' + id, { method: 'DELETE' })
      if (!r.ok) { const d = await r.json(); throw new Error(d.error || 'Error') }
      if (id === cloudId) setCloudId(null)
      cargarLista()
    } catch (e) { setCloud((c) => ({ ...(c || {}), err: e.message || 'No se pudo borrar' })) }
  }

  const abrirModalNube = () => {
    setCloud({ tab: auth ? 'list' : 'login', email: auth?.user?.email || '', password: '', nombre: '', err: '', msg: '', list: [] })
    if (auth) cargarLista()
  }

  // ---------- Importar cámara desde datasheet (Claude visión) ----------
  const importarDatasheet = async (file) => {
    if (!file) return
    setDsLoading(true)
    try {
      let dataUrl
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        const buf = await file.arrayBuffer()
        const { pdfABackground } = await import('./lib/pdf')
        const bg = await pdfABackground(buf)
        dataUrl = bg.url
      } else {
        dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file) })
      }
      const r = await fetch(API_IA + '/api/datasheet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imagenDataUrl: dataUrl }) })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Error del servidor')
      setDsResult(data.camara)
    } catch (e) { alert(e.message || 'No se pudo leer el datasheet') } finally { setDsLoading(false) }
  }

  const confirmarDatasheet = () => {
    const c = dsResult
    const slug = ((c.marca || '') + (c.modelo || '')).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 28)
    const cam = { ...c, id: 'user-' + slug + '-' + Date.now().toString(36), _user: true }
    if (!cam.resolucion_w && cam.mp) { cam.resolucion_w = Math.round(Math.sqrt((cam.mp * 1e6 * 16) / 9)); cam.resolucion_h = Math.round((cam.resolucion_w * 9) / 16) }
    if (!Array.isArray(cam.lentes) || !cam.lentes.length) cam.lentes = [{ focal_mm: 4, hfov_publicado_deg: null }]
    setCustomCams((a) => [...a, cam])
    if (auth) apiAuth('/api/camaras', { method: 'POST', body: JSON.stringify({ camara: cam }) }).catch(() => {})
    setMarca(cam.marca); setCatSel(cam.id); setCatTab('camaras')
    setDsResult(null)
  }

  const borrarCamUser = (id) => {
    setCustomCams((a) => a.filter((c) => c.id !== id)); if (catSel === id) setCatSel(null)
    if (auth) apiAuth('/api/camaras/' + id, { method: 'DELETE' }).catch(() => {})
  }

  // Sincroniza el catálogo del usuario con la nube al iniciar sesión (sube las locales nuevas).
  const cargarCamarasNube = async () => {
    if (!auth) return
    try {
      const r = await apiAuth('/api/camaras')
      if (!r.ok) return
      const nube = (await r.json()).camaras || []
      const ids = new Set(nube.map((c) => c.id))
      const localOnly = customCams.filter((c) => !ids.has(c.id))
      for (const c of localOnly) { try { await apiAuth('/api/camaras', { method: 'POST', body: JSON.stringify({ camara: c }) }) } catch { /* */ } }
      setCustomCams([...nube, ...localOnly])
    } catch { /* */ }
  }
  useEffect(() => { if (auth) cargarCamarasNube() }, [auth?.token])

  const camSel = sel?.kind === 'cam' ? proj.cameras.find((c) => c.id === sel.id) : null
  const devSelObj = sel?.kind === 'dev' ? proj.devices.find((d) => d.id === sel.id) : null
  const ppm = proj.pxPerMeter || 40
  const cams = customCams.length ? [...CAMS, ...customCams] : CAMS
  const marcas = customCams.length ? [...new Set(cams.map((c) => c.marca))] : MARCAS

  const cableM = commitPiso(proj).pisos.reduce((s, f) => s + (f.pxPerMeter ? (f.cables || []).reduce((a, c) => a + dist(c.x1, c.y1, c.x2, c.y2), 0) / f.pxPerMeter : 0), 0)

  return (
    <div className="app">
      <header className="bar">
        <span className="logo">📡 WIFIPlan</span>
        <input className="proj-name" value={proj.nombre} onChange={(e) => set({ nombre: e.target.value })} />
        <button className={'btn ' + (auth ? 'on' : '')} onClick={abrirModalNube} title="Guardar / abrir proyectos en la nube">☁️ {cloudId ? 'Guardado' : 'Proyectos'}</button>
        <label className="btn"><input type="file" accept="image/*,application/pdf,.dxf" style={{ display: 'none' }} onChange={(e) => subirPlano(e.target.files[0])} />📐 Plano</label>
        <button className="btn" onClick={() => setSat({ dir: '', metros: 120, tipo: 'satellite', loading: false, err: '' })} title="Traer imagen del sitio por dirección (satélite, híbrido o mapa)">🛰️ Satélite</button>
        <button className={'btn ' + (mode === 'scale' ? 'on' : '')} onClick={() => { setMode('scale'); setScalePts([]) }}>📏 Escala</button>
        <button className={'btn ' + (mode === 'wall' ? 'on' : '')} onClick={() => { setMode(mode === 'wall' ? 'select' : 'wall'); setLineStart(null) }}>🧱 Muro</button>
        <button className={'btn ' + (mode === 'rect' ? 'on' : '')} onClick={() => { setMode(mode === 'rect' ? 'select' : 'rect'); setLineStart(null) }} title="Dibujar una sala (rectángulo) en 2 clics">▭ Sala</button>
        <select className="in" style={{ width: 'auto', margin: 0, padding: '6px 8px' }} value={matSel} onChange={(e) => setMatSel(e.target.value)} title="Material del muro a dibujar">{MATERIALES.map((m) => <option key={m.key} value={m.key}>{m.nombre} ({m.db}dB)</option>)}</select>
        <button className={'btn ' + (mode === 'delwall' ? 'on' : '')} onClick={() => { setMode(mode === 'delwall' ? 'select' : 'delwall'); setLineStart(null) }} title="Borrar muros: clic en un muro para eliminarlo">🧹 Borrar muro</button>
        <button className="btn" disabled={murosLoading} onClick={detectarMurosIA} title="Detectar recintos con IA (aproximado)">{murosLoading ? '🪄…' : '🪄 Muros IA'}</button>
        <button className={'btn ' + (mode === 'cable' ? 'on' : '')} onClick={() => { setMode(mode === 'cable' ? 'select' : 'cable'); setLineStart(null) }}>🔗 Cable</button>
        {mode === 'wall' && <button className="btn" onClick={() => deshacerLinea('walls')}>↶</button>}
        {mode === 'cable' && <button className="btn" onClick={() => deshacerLinea('cables')}>↶</button>}
        <button className={'btn ' + (mode === 'select' ? 'on' : '')} onClick={() => setMode('select')}>🖐️</button>
        <button className="btn" onClick={() => fitView()}>🔍</button>
        <button className="btn" onClick={undo} title="Deshacer (Ctrl+Z)">↶</button>
        <button className="btn" onClick={redo} title="Rehacer (Ctrl+Y)">↷</button>
        <div className="spacer" />
        <span className="escala">{proj.pxPerMeter ? `${proj.pxPerMeter.toFixed(1)} px/m ✓` : '⚠️ sin escala'}</span>
        <button className="btn" onClick={() => setMarcaModal(true)} title="Tu logo, empresa y cliente para la propuesta">🏢 Marca</button>
        <button className="btn on" onClick={() => abrirPropuesta(buildBom(proj), { empresa, cliente: proj.cliente })}>📄 Propuesta</button>
        <button className="btn" onClick={() => { if (confirm('¿Nuevo proyecto? Se borra el actual.')) { snapshot(); setProj(nuevoProyecto()); setSel(null) } }}>✚</button>
      </header>

      <div className="floors">
        <span className="floors-lbl">🏢 Pisos:</span>
        {proj.pisos.map((f, i) => (
          <button key={f.id} className={'floor ' + (i === proj.pisoActivo ? 'on' : '')} onClick={() => cambiarPiso(i)}>
            {f.nombre || 'Piso ' + (i + 1)}
            {i === proj.pisoActivo && proj.pisos.length > 1 && <span className="fx" title="Borrar piso" onClick={(e) => { e.stopPropagation(); borrarPiso(i) }}>×</span>}
          </button>
        ))}
        <button className="floor add" onClick={agregarPiso} title="Agregar piso">＋ Piso</button>
        <button className="floor" onClick={renombrarActivo} title="Renombrar piso actual">✏️</button>
      </div>

      <div className="layout">
        <aside className="side">
          <div className="tabs">
            <button className={catTab === 'camaras' ? 'tab on' : 'tab'} onClick={() => setCatTab('camaras')}>📡 Access Points</button>
            <button className={catTab === 'dispositivos' ? 'tab on' : 'tab'} onClick={() => setCatTab('dispositivos')}>🔌 Red</button>
          </div>

          {catTab === 'camaras' && <>
            <select className="in" value={marca} onChange={(e) => setMarca(e.target.value)}>{marcas.map((m) => <option key={m}>{m}</option>)}</select>
            <div className="cat">
              {cams.filter((c) => c.marca === marca).map((c) => (
                <button key={c.id} className={'cat-item ' + (catSel === c.id && mode === 'camera' ? 'on' : '')} onClick={() => { setCatSel(c.id); setMode('camera') }}>
                  <b>{c.modelo}</b><span>WiFi {String(c.wifi).toUpperCase()} · {c.tipo} · ${c.precio_usd}</span>
                </button>
              ))}
            </div>
          </>}
          {catTab === 'dispositivos' && <div className="cat">
            {DEVS.map((d) => (
              <button key={d.id} className={'cat-item ' + (devSel === d.id && mode === 'device' ? 'on' : '')} onClick={() => { setDevSel(d.id); setMode('device') }}>
                <b>{d.icono} {d.modelo}</b><span>{d.tipo}</span>
              </button>
            ))}
          </div>}
          {(mode === 'camera' || mode === 'device') && <div className="hint">Toca el plano para colocar 📍</div>}

          {camSel && <CamProps cam={camSel} cat={catById(camSel.catId)} aps={proj.cameras} onUpd={updCam} onDel={delSel} />}
          {devSelObj && <div className="props"><h3 className="sec">{devById(devSelObj.devId)?.icono} {devById(devSelObj.devId)?.modelo}</h3><button className="btn danger" onClick={delSel}>🗑️ Eliminar</button></div>}

          {calcSistema(proj).nAP > 0 && <SistemaPanel proj={proj} onAplicar={() => { const s = calcSistema(proj); const ex = [{ key: 'switch', label: 'Switch PoE ' + s.puertos + ' puertos', qty: 1 }]; if (s.ctrl) ex.push({ key: 'ctrl', label: 'Controladora / licencias', qty: 1 }); set({ extras: ex }) }} />}

          <BOMPanel proj={proj} cableM={cableM} onPrecio={(k, v) => set({ precios: { ...proj.precios, [k]: v } })} onCable={(v) => set({ precioCableM: v })} />
        </aside>

        <main className="canvas">
          <svg ref={svgRef} className="svg" onPointerDown={onPointerDown}>
            <g transform={`translate(${view.tx},${view.ty}) scale(${view.zoom})`}>
              {proj.bg?.url && <image href={proj.bg.url} x={0} y={0} width={proj.bg.w} height={proj.bg.h} />}
              {!proj.bg && <text x={20} y={40} fill="#5b6b86" fontSize={18}>Sube un plano para empezar →</text>}

              {proj.cameras.map((cam, i) => {
                const cat = catById(cam.catId); if (!cat) return null
                const maxR = coberturaWifi(cat, cam.banda || '5', cam.potencia).rings[0].r_m * ppm
                const co = proj.cameras.some((o) => o.id !== cam.id && (o.banda || '5') === (cam.banda || '5') && o.canal === cam.canal && dist(o.x, o.y, cam.x, cam.y) < maxR)
                return <CamView key={cam.id} cam={cam} idx={i + 1} cat={cat} ppm={ppm} walls={proj.walls} sel={sel?.kind === 'cam' && sel.id === cam.id} onDown={(e) => startDrag(e, 'cam', cam)} coCanal={co} />
              })}

              {proj.cables.map((c, i) => <line key={'k' + i} x1={c.x1} y1={c.y1} x2={c.x2} y2={c.y2} stroke="#22d3ee" strokeWidth={2} strokeDasharray="6 4" vectorEffect="non-scaling-stroke" />)}
              {proj.walls.map((w, i) => (
                <g key={'w' + i}>
                  <line x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} stroke={matColor(w.mat || MAT_DEFAULT)} strokeWidth={4} strokeLinecap="round" vectorEffect="non-scaling-stroke" style={{ pointerEvents: mode === 'delwall' ? 'none' : 'auto' }}><title>{matNombre(w.mat || MAT_DEFAULT)}</title></line>
                  {mode === 'delwall' && <line x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} stroke="transparent" strokeWidth={16} vectorEffect="non-scaling-stroke" style={{ cursor: 'pointer' }} onPointerDown={(e) => { e.stopPropagation(); borrarMuro(i) }} />}
                </g>
              ))}

              {proj.devices.map((d, i) => {
                const dd = devById(d.devId)
                return (
                  <g key={d.id} onPointerDown={(e) => startDrag(e, 'dev', d)} style={{ cursor: 'move' }}>
                    <rect x={d.x - 12} y={d.y - 12} width={24} height={24} rx={5} fill={sel?.kind === 'dev' && sel.id === d.id ? '#0ea5e9' : '#1f2937'} stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                    <text x={d.x} y={d.y + 5} fontSize={13} textAnchor="middle" style={{ pointerEvents: 'none' }}>{dd?.icono || '⬛'}</text>
                  </g>
                )
              })}

              {autoPts.length > 0 && <polyline points={autoPts.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#a855f7" strokeWidth={2} strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />}
              {autoPts.map((p, i) => <circle key={'a' + i} cx={p.x} cy={p.y} r={3} fill="#a855f7" vectorEffect="non-scaling-stroke" />)}
              {lineStart && <circle cx={lineStart.x} cy={lineStart.y} r={4} fill={mode === 'cable' ? '#22d3ee' : '#0ea5e9'} vectorEffect="non-scaling-stroke" />}
              {scalePts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={4} fill="#22c55e" vectorEffect="non-scaling-stroke" />)}
            </g>
          </svg>
          <div className="legend">{BANDAS.slice().reverse().map((b) => (<span key={b.key}><i style={{ background: b.fill }} />{b.label}</span>))}</div>
          {proj.walls.length > 0 && <div className="legend mat-legend">{MATERIALES.map((m) => <span key={m.key}><i style={{ background: m.color }} />{m.nombre.split(' ')[0]} {m.db}dB</span>)}</div>}
        </main>
      </div>

      {dxf && (
        <div className="modal-bg" onClick={() => setDxf(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="sec">Importar capas del DXF como muros</h3>
            <div className="muted">Marca las capas que son murallas / construcción / cierre perimetral. {dxf.data.pxPerMeter ? '✓ Escala detectada del DXF.' : 'Sin unidades: calibra con 📏 luego.'}</div>
            <div className="layer-list">
              {dxf.data.layers.map((l) => (
                <label className="layer-row" key={l.name}>
                  <input type="checkbox" checked={dxf.sel.has(l.name)} onChange={() => toggleCapa(l.name)} />
                  <span className="ln">{l.name}</span><span className="lc">{l.count}</span>
                </label>
              ))}
            </div>
            <button className="btn on" style={{ width: '100%' }} onClick={importarCapas}>Importar {dxf.sel.size} capa(s)</button>
            <button className="btn" style={{ width: '100%', marginTop: 6 }} onClick={() => setDxf(null)}>Cancelar</button>
          </div>
        </div>
      )}

      {sat && (
        <div className="modal-bg" onClick={() => !sat.loading && setSat(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="sec">🛰️ Imagen satelital por dirección</h3>
            <div className="muted">Escribe la dirección del sitio. Traigo la foto aérea <b>ya a escala real</b> — lista para diseñar exteriores.</div>
            <input className="in" placeholder="Ej: Av. Apoquindo 6410, Las Condes, Chile" value={sat.dir}
              onChange={(e) => setSat((s) => ({ ...s, dir: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') buscarSatelite() }} autoFocus />
            <label className="lbl">Tipo de imagen</label>
            <div className="tabs">
              <button className={sat.tipo === 'satellite' ? 'tab on' : 'tab'} onClick={() => setSat((s) => ({ ...s, tipo: 'satellite' }))}>🛰️ Satélite</button>
              <button className={sat.tipo === 'hybrid' ? 'tab on' : 'tab'} onClick={() => setSat((s) => ({ ...s, tipo: 'hybrid' }))}>🗺️ Híbrido</button>
              <button className={sat.tipo === 'roadmap' ? 'tab on' : 'tab'} onClick={() => setSat((s) => ({ ...s, tipo: 'roadmap' }))}>🛣️ Mapa</button>
            </div>
            <label className="lbl">Área a cubrir: {sat.metros} m de lado</label>
            <input className="range" type="range" min={40} max={400} step={10} value={sat.metros}
              onChange={(e) => setSat((s) => ({ ...s, metros: +e.target.value }))} />
            {sat.err && <div className="err">{sat.err}</div>}
            <button className="btn on" style={{ width: '100%', marginTop: 10 }} disabled={sat.loading} onClick={buscarSatelite}>{sat.loading ? 'Buscando…' : 'Traer imagen'}</button>
            <button className="btn" style={{ width: '100%', marginTop: 6 }} disabled={sat.loading} onClick={() => setSat(null)}>Cancelar</button>
          </div>
        </div>
      )}

      {cloud && (
        <div className="modal-bg" onClick={() => setCloud(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            {!auth ? (
              <>
                <h3 className="sec">☁️ Proyectos en la nube</h3>
                <div className="tabs">
                  <button className={cloud.tab === 'login' ? 'tab on' : 'tab'} onClick={() => setCloud((c) => ({ ...c, tab: 'login', err: '' }))}>Entrar</button>
                  <button className={cloud.tab === 'register' ? 'tab on' : 'tab'} onClick={() => setCloud((c) => ({ ...c, tab: 'register', err: '' }))}>Crear cuenta</button>
                </div>
                {cloud.tab === 'register' && <input className="in" placeholder="Tu nombre" value={cloud.nombre} onChange={(e) => setCloud((c) => ({ ...c, nombre: e.target.value }))} />}
                <input className="in" placeholder="Email" type="email" value={cloud.email} onChange={(e) => setCloud((c) => ({ ...c, email: e.target.value }))} />
                <input className="in" placeholder="Contraseña (mín. 6)" type="password" value={cloud.password} onChange={(e) => setCloud((c) => ({ ...c, password: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') doAuth() }} />
                {cloud.err && <div className="err">{cloud.err}</div>}
                <button className="btn on" style={{ width: '100%', marginTop: 6 }} disabled={cloud.loading} onClick={doAuth}>{cloud.loading ? '…' : (cloud.tab === 'register' ? 'Crear cuenta' : 'Entrar')}</button>
                <button className="btn" style={{ width: '100%', marginTop: 6 }} onClick={() => setCloud(null)}>Cancelar</button>
              </>
            ) : (
              <>
                <h3 className="sec">☁️ Mis proyectos</h3>
                <div className="muted">{auth.user?.email} · <span style={{ color: '#7dd3fc', cursor: 'pointer' }} onClick={logout}>Cerrar sesión</span></div>
                <button className="btn on" style={{ width: '100%', marginTop: 8 }} disabled={cloud.saving} onClick={() => guardarNube(false)}>{cloud.saving ? 'Guardando…' : (cloudId ? '💾 Guardar cambios' : '💾 Guardar este proyecto')}</button>
                {cloudId && <button className="btn" style={{ width: '100%', marginTop: 6 }} disabled={cloud.saving} onClick={() => guardarNube(true)}>📑 Guardar como copia nueva</button>}
                {cloud.msg && <div className="hint" style={{ marginTop: 8 }}>{cloud.msg}</div>}
                {cloud.err && <div className="err">{cloud.err}</div>}
                <div className="layer-list" style={{ marginTop: 10 }}>
                  {(cloud.list || []).length === 0 && <div className="muted" style={{ padding: 12 }}>Aún no tienes proyectos guardados. Diseña y pulsa "Guardar".</div>}
                  {(cloud.list || []).map((p) => (
                    <div className="layer-row" key={p.id}>
                      <span className="ln" style={{ cursor: 'pointer' }} onClick={() => abrirNube(p.id)}>{p.id === cloudId ? '● ' : ''}{p.nombre}</span>
                      <button className="btn" style={{ padding: '3px 8px' }} onClick={() => abrirNube(p.id)}>Abrir</button>
                      <button className="btn" style={{ padding: '3px 8px' }} onClick={() => borrarNube(p.id)} title="Borrar">🗑</button>
                    </div>
                  ))}
                </div>
                <button className="btn" style={{ width: '100%', marginTop: 6 }} onClick={() => setCloud(null)}>Cerrar</button>
              </>
            )}
          </div>
        </div>
      )}

      {dsResult && (
        <div className="modal-bg" onClick={() => setDsResult(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="sec">📄 Cámara leída del datasheet</h3>
            <div className="muted">Revisa los datos y confírmalos. Confianza de lectura: <b>{dsResult.confianza || '—'}</b></div>
            <div className="dsbox">
              <div className="ds-tit">{dsResult.marca} {dsResult.modelo}</div>
              <div className="muted">{dsResult.tipo} · {dsResult.mp}MP · sensor {dsResult.sensor_formato}"{dsResult.resolucion_w ? ` · ${dsResult.resolucion_w}×${dsResult.resolucion_h}` : ''}</div>
              <div className="muted">Lentes: {(dsResult.lentes || []).map((l) => l.focal_mm + 'mm' + (l.hfov_publicado_deg ? ` (${l.hfov_publicado_deg}°)` : '')).join(', ') || '—'}</div>
              <div className="muted">{[dsResult.ir_alcance_m ? 'IR ' + dsResult.ir_alcance_m + 'm' : '', dsResult.ip_rating, dsResult.ik_rating, dsResult.poe ? 'PoE' : ''].filter(Boolean).join(' · ')}</div>
              {!!(dsResult.caracteristicas || []).length && <div className="muted">{dsResult.caracteristicas.join(' · ')}</div>}
            </div>
            {dsResult.confianza === 'baja' && <div className="err">Lectura de baja confianza — verifica los datos contra el datasheet antes de usar.</div>}
            <button className="btn on" style={{ width: '100%', marginTop: 8 }} onClick={confirmarDatasheet}>Agregar al catálogo</button>
            <button className="btn" style={{ width: '100%', marginTop: 6 }} onClick={() => setDsResult(null)}>Descartar</button>
          </div>
        </div>
      )}

      {marcaModal && (
        <div className="modal-bg" onClick={() => setMarcaModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="sec">🏢 Marca de la propuesta</h3>
            <div className="muted">Tu logo y datos salen en el PDF de propuesta. Se guardan en este navegador.</div>
            <label className="lbl">Logo de tu empresa</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
              {empresa.logo && <img src={empresa.logo} alt="logo" style={{ height: 40, maxWidth: 120, objectFit: 'contain', background: '#fff', borderRadius: 6, padding: 3 }} />}
              <label className="btn" style={{ flex: 1, textAlign: 'center' }}><input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => subirLogo(e.target.files[0])} />{empresa.logo ? 'Cambiar logo' : 'Subir logo'}</label>
              {empresa.logo && <button className="btn" onClick={() => setEmpresa((e) => ({ ...e, logo: null }))}>Quitar</button>}
            </div>
            <label className="lbl">Nombre de tu empresa</label>
            <input className="in" placeholder="Ej: Axionet Seguridad" value={empresa.nombre || ''} onChange={(e) => setEmpresa((p) => ({ ...p, nombre: e.target.value }))} />
            <label className="lbl">Contacto (pie de página)</label>
            <input className="in" placeholder="Ej: contacto@axionet.io · +56 9 1234 5678" value={empresa.contacto || ''} onChange={(e) => setEmpresa((p) => ({ ...p, contacto: e.target.value }))} />
            <label className="lbl">Cliente de este proyecto</label>
            <input className="in" placeholder="Ej: Condominio Los Robles" value={proj.cliente || ''} onChange={(e) => set({ cliente: e.target.value })} />
            <button className="btn on" style={{ width: '100%', marginTop: 6 }} onClick={() => setMarcaModal(false)}>Listo</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── BOM (cálculo) ───────────────────────────────────────────────────────────
export function buildBom(proj) {
  const p = commitPiso(proj)
  const floors = p.pisos || [{ cameras: p.cameras, devices: p.devices, cables: p.cables, pxPerMeter: p.pxPerMeter }]
  const grupos = {}
  for (const f of floors) {
    for (const c of (f.cameras || [])) {
      const cat = catById(c.catId); if (!cat) continue
      grupos[c.catId] = grupos[c.catId] || { key: c.catId, label: cat.marca + ' ' + cat.modelo, tipo: 'Access Point', qty: 0 }
      grupos[c.catId].qty++
    }
    for (const d of (f.devices || [])) {
      const dd = devById(d.devId); if (!dd) continue
      grupos[d.devId] = grupos[d.devId] || { key: d.devId, label: dd.modelo, tipo: 'Equipo', qty: 0 }
      grupos[d.devId].qty++
    }
  }
  for (const e of (p.extras || [])) {
    if (e.qty > 0) grupos['x_' + e.key] = { key: 'x_' + e.key, label: e.label, tipo: 'Sistema', qty: e.qty }
  }
  const cableM = floors.reduce((s, f) => s + (f.pxPerMeter ? (f.cables || []).reduce((a, c) => a + Math.hypot(c.x2 - c.x1, c.y2 - c.y1), 0) / f.pxPerMeter : 0), 0)
  const rows = Object.values(grupos).map((g) => {
    const unit = Number(proj.precios?.[g.key]) || 0
    return { ...g, unit, subtotal: unit * g.qty }
  })
  const cableUnit = Number(proj.precioCableM) || 0
  const cableRow = { key: '_cable', label: 'Cable UTP', tipo: 'Cable', qty: +cableM.toFixed(1), unit: cableUnit, subtotal: cableUnit * cableM, esMetros: true }
  const neto = rows.reduce((s, r) => s + r.subtotal, 0) + cableRow.subtotal
  const iva = Math.round(neto * 0.19)
  return { nombre: proj.nombre, rows, cableRow, neto, iva, total: neto + iva }
}

// Tipo normalizado para el ícono referencial de la cámara.
function tipoCam(t) {
  t = (t || '').toLowerCase()
  if (t.includes('ptz')) return 'ptz'
  if (t.includes('multi')) return 'multi'
  if (t.includes('fish') || t.includes('ojo')) return 'fisheye'
  if (t.includes('turret')) return 'turret'
  if (t.includes('bullet')) return 'bullet'
  if (t.includes('dome') || t.includes('domo')) return 'dome'
  return 'cam'
}

// Silueta del tipo de cámara, apuntando a +x (se rota con la orientación).
function glifoCam(tipo, f) {
  const d = '#0b1220', s = { stroke: '#fff', strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke' }
  switch (tipo) {
    case 'bullet': return <g><rect x={-8} y={-4} width={13} height={8} rx={4} fill={f} {...s} /><circle cx={5} cy={0} r={3.1} fill={d} stroke="#fff" strokeWidth={1} vectorEffect="non-scaling-stroke" /></g>
    case 'dome': return <g><path d="M -8 3 A 8 8 0 0 1 8 3 Z" fill={f} {...s} /><circle cx={0} cy={1} r={2.4} fill={d} /></g>
    case 'turret': return <g><circle r={8} fill={f} {...s} /><circle cx={2.6} cy={0} r={3.4} fill={d} stroke="#fff" strokeWidth={1} vectorEffect="non-scaling-stroke" /></g>
    case 'ptz': return <g><circle r={8} fill={f} {...s} /><rect x={-8} y={-9.5} width={16} height={4} rx={2} fill={f} {...s} /><circle cx={3} cy={0} r={2.6} fill={d} /></g>
    case 'multi': return <g><circle r={8} fill={f} {...s} />{[[0, -3.6], [3.6, 0], [0, 3.6], [-3.6, 0]].map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={1.6} fill={d} />)}</g>
    case 'fisheye': return <g><circle r={8} fill={f} {...s} /><circle r={4} fill="none" stroke={d} strokeWidth={1.5} /><circle r={1.4} fill={d} /></g>
    default: return <circle r={7} fill={f} stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
  }
}

// FOV vertical (grados) desde el HFOV y la relación de aspecto del sensor.
function vfovDeg(cat, hfovDeg) {
  const aspect = cat.resolucion_h && cat.resolucion_w ? cat.resolucion_h / cat.resolucion_w : 9 / 16
  return (2 * Math.atan(Math.tan(((hfovDeg * Math.PI) / 180) / 2) * aspect) * 180) / Math.PI
}
// Huella en el piso según altura de montaje + inclinación (tilt). Devuelve metros.
function huellaSuelo(cat, cam, hfovDeg) {
  const H = +cam.altura || 0, T = +cam.tilt || 0
  const vfov = vfovDeg(cat, hfovDeg)
  if (H <= 0 || T <= 0) return { vfov, near: 0, far: Infinity }
  const nearA = T + vfov / 2, farA = T - vfov / 2
  const near = Math.max(0, H / Math.tan((nearA * Math.PI) / 180))
  const far = farA > 0.5 ? H / Math.tan((farA * Math.PI) / 180) : Infinity
  return { vfov, near, far }
}

// ─── Vista de AP con heatmap de señal (atenuado por muros/material) ──────────
function CamView({ cam, idx, cat, ppm, walls, sel, onDown, coCanal }) {
  if (!cat) return null
  const banda = cam.banda || '5'
  const cov = coberturaWifi(cat, banda, cam.potencia)
  const maxR = cov.rings[0].r_m * ppm // anillo "regular" (el mayor)
  const steps = 64
  const ang = []
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI
    const dx = Math.cos(a), dy = Math.sin(a)
    const cross = []
    for (const w of walls) {
      const t = raySeg(cam.x, cam.y, dx, dy, w.x1, w.y1, w.x2, w.y2)
      if (t != null && t > 0.5 && t < maxR) cross.push({ t, k: Math.pow(10, -atenuacionMuro(w.mat || MAT_DEFAULT, banda) / 30) })
    }
    cross.sort((u, v) => u.t - v.t)
    ang.push({ dx, dy, cross })
  }
  // El alcance es full hasta el muro y recién detrás de él se atenúa (por cada muro que cruza).
  const poly = (rPx) => ang.map((p) => {
    let reach = rPx
    for (const c of p.cross) { if (c.t >= reach) break; reach = c.t + (reach - c.t) * c.k }
    return `${(cam.x + p.dx * reach).toFixed(1)},${(cam.y + p.dy * reach).toFixed(1)}`
  }).join(' ')
  const col = coCanal ? '#ef4444' : sel ? '#0ea5e9' : '#6366f1'
  return (
    <g onPointerDown={onDown} style={{ cursor: 'move' }}>
      {cov.rings.map((b) => <polygon key={b.key} points={poly(b.r_m * ppm)} fill={b.fill} stroke="none" />)}
      <g transform={`translate(${cam.x},${cam.y})`}>
        <circle r={11} fill={col} stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        <circle cx={0} cy={3} r={1.5} fill="#fff" />
        <path d="M -3.5 0.5 A 4 4 0 0 1 3.5 0.5" stroke="#fff" strokeWidth={1.5} fill="none" />
        <path d="M -6 -2 A 6.5 6.5 0 0 1 6 -2" stroke="#fff" strokeWidth={1.5} fill="none" />
      </g>
      <text x={cam.x + 13} y={cam.y - 8} fill="#e6edf7" fontSize={12} stroke="#0b1220" strokeWidth={3} paintOrder="stroke" style={{ pointerEvents: 'none' }}>AP{idx} · {NOMBRE_BANDA[banda]} C{cam.canal}{coCanal ? ' ⚠️' : ''}</text>
    </g>
  )
}

function CamProps({ cam, cat, aps, onUpd, onDel }) {
  if (!cat) return null
  const bandas = bandasPorWifi(cat.wifi)
  const banda = cam.banda || '5'
  const cov = coberturaWifi(cat, banda, cam.potencia)
  const co = (aps || []).some((o) => o.id !== cam.id && (o.banda || '5') === banda && o.canal === cam.canal)
  const lic = cat.licencia && cat.licencia !== 'ninguna' ? 'licencia ' + cat.licencia : 'sin licencia'
  return (
    <div className="props">
      <h3 className="sec">{cat.marca} {cat.modelo}</h3>
      <div className="muted">WiFi {String(cat.wifi).toUpperCase()} · {cat.tipo} · {lic}</div>
      <label className="lbl">Banda</label>
      <select className="in" value={banda} onChange={(e) => onUpd(cam.id, { banda: e.target.value, canal: canalSugerido(e.target.value, 0) })}>
        {bandas.map((b) => <option key={b} value={b}>{NOMBRE_BANDA[b]}</option>)}
      </select>
      <label className="lbl">Canal {co && <span style={{ color: '#fca5a5', margin: 0 }} className="muted">· ⚠️ co-canal con otro AP</span>}</label>
      <select className="in" value={cam.canal} onChange={(e) => onUpd(cam.id, { canal: +e.target.value })}>
        {(CANALES[banda] || []).map((c) => <option key={c} value={c}>Canal {c}</option>)}
      </select>
      <label className="lbl">Potencia TX: {cam.potencia || 100}%</label>
      <input className="range" type="range" min={20} max={100} step={5} value={cam.potencia || 100} onChange={(e) => onUpd(cam.id, { potencia: +e.target.value })} />
      <div className="dori">
        <div><b>Cobertura {NOMBRE_BANDA[banda]}</b> <span className="muted" style={{ margin: 0 }}>(con muros)</span></div>
        {cov.rings.slice().reverse().map((r) => <div className="d-row" key={r.key}><span>{r.label}</span><b>{r.r_m.toFixed(1)} m</b></div>)}
      </div>
      <button className="btn danger" onClick={() => onDel()}>🗑️ Eliminar AP</button>
    </div>
  )
}

function SistemaPanel({ proj, onAplicar }) {
  const s = calcSistema(proj)
  return (
    <div className="props">
      <h3 className="sec">📊 Dimensionamiento de red</h3>
      <div className="dori">
        <div className="d-row"><span>Access Points</span><b>{s.nAP}</b></div>
        <div className="d-row"><span>Consumo PoE est.</span><b>{s.watts} W</b></div>
        <div className="d-row"><span>Switch PoE</span><b>{s.puertos} puertos</b></div>
        <div className="d-row"><span>Controladora</span><b>{s.ctrl ? 'Requerida' : 'Opcional'}</b></div>
      </div>
      <button className="btn on" style={{ width: '100%', marginTop: 8 }} onClick={onAplicar}>➕ Agregar switch PoE / controladora al presupuesto</button>
    </div>
  )
}

function BOMPanel({ proj, cableM, onPrecio, onCable }) {
  const bom = buildBom(proj)
  if (bom.rows.length === 0 && cableM === 0) return null
  return (
    <div className="props">
      <h3 className="sec">📋 Materiales y precios</h3>
      {bom.rows.map((r) => (
        <div className="bom-edit" key={r.key}>
          <div className="bom-l"><b>{r.label}</b><span>×{r.qty}</span></div>
          <input className="precio" type="number" placeholder="precio unit" value={proj.precios?.[r.key] || ''} onChange={(e) => onPrecio(r.key, +e.target.value)} />
        </div>
      ))}
      <div className="bom-edit">
        <div className="bom-l"><b>Cable UTP</b><span>{cableM.toFixed(1)} m</span></div>
        <input className="precio" type="number" placeholder="$/m" value={proj.precioCableM || ''} onChange={(e) => onCable(+e.target.value)} />
      </div>
      <div className="tot">
        <div className="t-row"><span>Neto</span><b>{clp(bom.neto)}</b></div>
        <div className="t-row"><span>IVA 19%</span><b>{clp(bom.iva)}</b></div>
        <div className="t-row tot-f"><span>Total</span><b>{clp(bom.total)}</b></div>
      </div>
    </div>
  )
}
