import { useState, useRef } from "react";

const CLANS = ["69R", "69S", "69D"];

const EVENT_TYPES = [
  { id:"weekly_chests", name:"Weekly Chests", frequency:"7 days",  fields:[{ key:"points",  label:"Points"  }] },
  { id:"tin_man",       name:"Tin Man",       frequency:"6 days",  fields:[{ key:"points",  label:"Points"  }] },
  { id:"ragnarok",      name:"Ragnarök",      frequency:"25 days", fields:[{ key:"points",  label:"Points"  }] },
  { id:"armageddon",    name:"Armageddon",    frequency:"25 days", fields:[{ key:"points",  label:"Points"  }] },
  { id:"omens",         name:"Omens",         frequency:"Monthly", fields:[{ key:"essence", label:"Essence" },{ key:"damage", label:"Damage" },{ key:"chests", label:"Chests" }] },
  { id:"olympus",       name:"Olympus",       frequency:"Monthly", fields:[{ key:"score",   label:"Score"   },{ key:"chests", label:"Chests" }] },
];

const LEVEL_TYPES = {
  G: { label:"Guard",      levels:["G1","G2","G3","G4","G5","G6","G7","G8","G9"] },
  M: { label:"Monster",    levels:["M1","M2","M3","M4","M5","M6","M7","M8","M9"] },
  S: { label:"Specialist", levels:["S1","S2","S3","S4","S5","S6","S7","S8","S9"] },
  E: { label:"Cannon",     levels:["E1","E2","E3","E4","E5","E6","E7","E8","E9"] },
};

// ─── STORAGE ──────────────────────────────────────────────────────────────────
function _ensure() { if (!window._appData) window._appData = {}; }
const storage = {
  getPlayers:        () => window._appData?.players       || [],
  savePlayers:       v  => { _ensure(); window._appData.players       = v; },
  getScores:         () => window._appData?.scores        || {},
  saveScores:        v  => { _ensure(); window._appData.scores        = v; },
  getLevelRequests:  () => window._appData?.levelRequests || [],
  saveLevelRequests: v  => { _ensure(); window._appData.levelRequests = v; },
  getRotationLog:    () => window._appData?.rotationLog   || [],
  saveRotationLog:   v  => { _ensure(); window._appData.rotationLog   = v; },
  getLastBackup:     ()  => window._appData?.lastBackup   || null,
  saveLastBackup:    v  => { _ensure(); window._appData.lastBackup    = v; },
};

if (!window._appData) {
  window._appData = {
    players: [
      { id:"p1", name:"DragonSlayer", clan:"69R", active:true,  levels:{ G:"G4", M:"M3", S:"S2", E:"E1" } },
      { id:"p2", name:"IronFist",     clan:"69R", active:true,  levels:{ G:"G6", M:"M5", S:"S4", E:"E3" } },
      { id:"p3", name:"NightHawk",    clan:"69S", active:true,  levels:{ G:"G3", M:"M2", S:"S1", E:"E2" } },
      { id:"p4", name:"StormBlade",   clan:"69S", active:true,  levels:{ G:"G5", M:"M4", S:"S3", E:"E2" } },
      { id:"p5", name:"PhantomX",     clan:"69D", active:true,  levels:{ G:"G2", M:"M2", S:"S1", E:"E1" } },
      { id:"p6", name:"Vortex",       clan:"69D", active:false, levels:{ G:"G1", M:"M1", S:"S1", E:"E1" } },
      { id:"p7", name:"GhostRider",   clan:"69R", active:true,  levels:{ G:null, M:"M2", S:"S1", E:"E1" } },
    ],
    scores: {},
    levelRequests: [
      { id:"lr1", playerId:"p3", playerName:"NightHawk", clan:"69S", levelType:"G", from:"G3", to:"G4", status:"pending", date:"2026-05-10" },
    ],
    rotationLog: [],
    lastBackup: null,
  };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const uid   = () => Math.random().toString(36).slice(2, 9);
const today = () => new Date().toISOString().slice(0, 10);
const useForceUpdate = () => { const [,setN] = useState(0); return () => setN(n=>n+1); };

// ─── FUZZY MATCH ──────────────────────────────────────────────────────────────
const normalise = s => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const levenshtein = (a, b) => {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m+1 }, (_, i) =>
    Array.from({ length: n+1 }, (_, j) => j === 0 ? i : 0)
  );
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
};

const strSimilarity = (a, b) => {
  const na = normalise(a), nb = normalise(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const dist = levenshtein(na, nb);
  return 1 - dist / Math.max(na.length, nb.length);
};

const fuzzyMatch = (name, players) => {
  const ranked = players
    .map(p => ({ player: p, score: strSimilarity(name, p.name) }))
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return { type: "none" };
  if (ranked[0].score >= 0.85) return { type: "exact",      player: ranked[0].player };
  if (ranked[0].score >= 0.45) return { type: "suggestion", player: ranked[0].player, score: ranked[0].score };
  return { type: "none" };
};

// ─── TREND HELPERS ────────────────────────────────────────────────────────────
const getPlayerEventScores = (playerId, clan, eventId) => {
  const entries = storage.getScores()[`${clan}_${eventId}`] || [];
  return entries
    .filter(e => e.scores && e.scores[playerId])
    .map(e => ({ date: e.date.slice(0, 10), values: e.scores[playerId] }));
};

const getTrend = (scores, fieldKey) => {
  if (!scores || scores.length < 2) return "none";
  const curr = Number(scores[0].values[fieldKey]);
  const prev = Number(scores[1].values[fieldKey]);
  if (isNaN(curr) || isNaN(prev)) return "none";
  if (curr > prev) return "up";
  if (curr < prev) return "down";
  return "flat";
};

const TrendBadge = ({ trend, size="sm" }) => {
  const cfg = {
    up:   { symbol:"↑", color:"#16a34a", bg:"#f0fdf4" },
    down: { symbol:"↓", color:"#dc2626", bg:"#fef2f2" },
    flat: { symbol:"→", color:"#64748b", bg:"#f1f5f9" },
    none: { symbol:"—", color:"#cbd5e1", bg:"#f8fafc" },
  }[trend] || { symbol:"—", color:"#cbd5e1", bg:"#f8fafc" };
  const pad = size === "lg" ? "3px 10px" : "2px 7px";
  const fs  = size === "lg" ? 14 : 12;
  return (
    <span style={{ backgroundColor:cfg.bg, color:cfg.color, borderRadius:4, padding:pad, fontSize:fs, fontWeight:700, fontFamily:"'DM Mono',monospace" }}>
      {cfg.symbol}
    </span>
  );
};

const formatScore = val => {
  const n = Number(val);
  if (isNaN(n) || val === "" || val === undefined) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 10_000)    return (n / 1_000).toFixed(0) + "k";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "k";
  return String(n);
};

const abbrev = name => ({
  "Weekly Chests": "WC",
  "Tin Man":       "TM",
  "Ragnarök":      "RG",
  "Armageddon":    "AM",
  "Omens":         "OM",
  "Olympus":       "OL",
}[name] || name.slice(0, 2).toUpperCase());

const getActionItems = () => {
  const players     = storage.getPlayers();
  const requests    = storage.getLevelRequests();
  const pending     = requests.filter(r => r.status === "pending");
  const missingGuard = players.filter(p => p.active && !p.levels?.G);
  return { pending, missingGuard, total: pending.length + missingGuard.length };
};

// ─── ICONS ────────────────────────────────────────────────────────────────────
const Icon = ({ name, size=22, color="currentColor" }) => {
  const s = { width:size, height:size, viewBox:"0 0 24 24", fill:"none", stroke:color, strokeWidth:"2", strokeLinecap:"round", strokeLinejoin:"round" };
  const icons = {
    players:    <svg {...s}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
    score:      <svg {...s}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
    trends:     <svg {...s}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
    admin:      <svg {...s}><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>,
    levelUp:    <svg {...s}><polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/></svg>,
    chevR:      <svg {...s}><polyline points="9 18 15 12 9 6"/></svg>,
    back:       <svg {...s}><polyline points="15 18 9 12 15 6"/></svg>,
    plus:       <svg {...s}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
    shield:     <svg {...s}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
    check:      <svg {...s} strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>,
    xmark:      <svg {...s} strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
    trophy:     <svg {...s}><polyline points="8 21 12 17 16 21"/><line x1="12" y1="17" x2="12" y2="11"/><path d="M7 4H4a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h3"/><path d="M17 4h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-3"/><rect x="7" y="2" width="10" height="12" rx="2"/></svg>,
    edit:       <svg {...s}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
    download:   <svg {...s}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
    upload:     <svg {...s}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
    arrowR:     <svg {...s}><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>,
    warning:    <svg {...s}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
    rotate:     <svg {...s}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
    userPlus:   <svg {...s}><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>,
    userMinus:  <svg {...s}><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="23" y1="11" x2="17" y2="11"/></svg>,
    history:    <svg {...s}><polyline points="12 8 12 12 14 14"/><path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"/></svg>,
    bell:       <svg {...s}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
  };
  return icons[name] || null;
};

// ─── SHARED COMPONENTS ────────────────────────────────────────────────────────
const ClanBadge = ({ clan }) => {
  const colors = { "69R":"#dc2626","69S":"#2563eb","69D":"#16a34a" };
  return <span style={{ backgroundColor:colors[clan]+"18", color:colors[clan], border:`1px solid ${colors[clan]}40`, borderRadius:6, padding:"2px 8px", fontSize:12, fontWeight:700, fontFamily:"'DM Mono',monospace" }}>{clan}</span>;
};

const LevelBadge = ({ type, value }) => {
  if (!value) return <span style={{ backgroundColor:"#fef2f2", color:"#dc2626", borderRadius:4, padding:"1px 6px", fontSize:11, fontWeight:600, fontFamily:"'DM Mono',monospace" }}>?</span>;
  const bg = { G:"#f0fdf4",M:"#fef3c7",S:"#eff6ff",E:"#fdf4ff" };
  const tx = { G:"#166534",M:"#92400e",S:"#1e40af",E:"#7e22ce" };
  return <span style={{ backgroundColor:bg[type], color:tx[type], borderRadius:4, padding:"1px 6px", fontSize:11, fontWeight:600, fontFamily:"'DM Mono',monospace" }}>{value}</span>;
};

const FreqTag = ({ freq }) => <span style={{ backgroundColor:"#f1f5f9", color:"#64748b", borderRadius:4, padding:"2px 7px", fontSize:11, fontWeight:500 }}>{freq}</span>;

const Card = ({ children, style={}, onClick }) => {
  const [pressed, setPressed] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseDown={onClick ? ()=>setPressed(true) : undefined}
      onMouseUp={onClick ? ()=>setPressed(false) : undefined}
      onMouseLeave={onClick ? ()=>setPressed(false) : undefined}
      onTouchStart={onClick ? ()=>setPressed(true) : undefined}
      onTouchEnd={onClick ? ()=>setPressed(false) : undefined}
      style={{
        backgroundColor:"#fff", borderRadius:14, padding:16,
        boxShadow:"0 1px 4px rgba(0,0,0,0.07),0 0 0 1px rgba(0,0,0,0.04)",
        cursor:onClick?"pointer":"default",
        transform: pressed ? "scale(0.985)" : "scale(1)",
        transition: "transform 0.1s ease, box-shadow 0.1s ease",
        ...style
      }}>
      {children}
    </div>
  );
};

const SecHeader = ({ title, action }) => (
  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
    <span style={{ fontSize:12, fontWeight:700, color:"#94a3b8", textTransform:"uppercase", letterSpacing:"0.08em" }}>{title}</span>
    {action}
  </div>
);

const EmptyState = ({ icon, message }) => (
  <div style={{ textAlign:"center", padding:"40px 20px", color:"#94a3b8" }}>
    <div style={{ marginBottom:10, opacity:0.4 }}><Icon name={icon} size={36} color="#94a3b8"/></div>
    <p style={{ fontSize:14, margin:0 }}>{message}</p>
  </div>
);

const BackBtn = ({ onBack }) => (
  <button onClick={onBack} style={{ background:"none", border:"none", color:"#3b82f6", fontSize:14, fontWeight:600, cursor:"pointer", padding:"0 0 16px", display:"flex", alignItems:"center", gap:4 }}>
    <Icon name="back" size={16} color="#3b82f6"/> Back
  </button>
);

const Label = ({ children }) => <div style={{ fontSize:12, fontWeight:700, color:"#64748b", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:6 }}>{children}</div>;

const inputStyle = { width:"100%", padding:"11px 14px", borderRadius:10, border:"1.5px solid #e2e8f0", fontSize:14, color:"#1e293b", outline:"none", backgroundColor:"#fff", fontFamily:"'Outfit',system-ui,sans-serif", boxSizing:"border-box" };

const SelField = ({ value, onChange, options, placeholder }) => (
  <select value={value} onChange={e=>onChange(e.target.value)} style={{ ...inputStyle, appearance:"none", backgroundImage:"url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E\")", backgroundRepeat:"no-repeat", backgroundPosition:"right 14px center", paddingRight:36 }}>
    <option value="">{placeholder}</option>
    {options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
  </select>
);

const Btn = ({ children, onClick, variant="secondary", size="md", fullWidth=false, disabled=false }) => {
  const variants = { primary:{backgroundColor:"#1e293b",color:"#fff"}, danger:{backgroundColor:"#dc2626",color:"#fff"}, success:{backgroundColor:"#16a34a",color:"#fff"}, ghost:{backgroundColor:"#f1f5f9",color:"#475569"} };
  const sizes    = { sm:{padding:"7px 14px",fontSize:13}, md:{padding:"10px 18px",fontSize:14}, lg:{padding:"13px 20px",fontSize:15} };
  return (
    <button onClick={disabled?undefined:onClick} style={{ border:"none", borderRadius:10, fontWeight:700, cursor:disabled?"not-allowed":"pointer", display:"inline-flex", alignItems:"center", justifyContent:"center", gap:6, opacity:disabled?0.45:1, fontFamily:"'Outfit',system-ui,sans-serif", ...(fullWidth?{width:"100%"}:{}), ...variants[variant], ...sizes[size] }}>
      {children}
    </button>
  );
};

const Modal = ({ title, message, confirmLabel, confirmVariant="primary", onConfirm, onCancel }) => (
  <div style={{ position:"fixed", inset:0, backgroundColor:"rgba(0,0,0,0.45)", zIndex:200, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
    <div style={{ backgroundColor:"#fff", borderRadius:"20px 20px 0 0", padding:"24px 20px 40px", width:"100%", maxWidth:430 }}>
      <h3 style={{ fontSize:18, fontWeight:800, color:"#1e293b", margin:"0 0 8px" }}>{title}</h3>
      <p style={{ fontSize:14, color:"#64748b", margin:"0 0 20px", lineHeight:1.5 }}>{message}</p>
      <div style={{ display:"flex", gap:10 }}>
        <Btn onClick={onCancel}  variant="ghost"          size="lg" fullWidth>Cancel</Btn>
        <Btn onClick={onConfirm} variant={confirmVariant} size="lg" fullWidth>{confirmLabel}</Btn>
      </div>
    </div>
  </div>
);

// ─── PLAYER FORM ──────────────────────────────────────────────────────────────
const PlayerForm = ({ player, onDone }) => {
  const isNew = !player;
  const [name,   setName]   = useState(player?.name || "");
  const [clan,   setClan]   = useState(player?.clan || "");
  const [levels, setLevels] = useState(player?.levels || { G:null,M:null,S:null,E:null });
  const [error,  setError]  = useState("");

  const save = () => {
    if (!name.trim()) { setError("Player name is required."); return; }
    if (!clan)        { setError("Please select a clan."); return; }
    const all = storage.getPlayers();
    if (isNew) {
      storage.savePlayers([...all, { id:uid(), name:name.trim(), clan, active:true, levels }]);
    } else {
      storage.savePlayers(all.map(p => p.id===player.id ? { ...p, name:name.trim(), clan, levels } : p));
    }
    onDone();
  };

  return (
    <div style={{ padding:"0 16px 16px" }}>
      <BackBtn onBack={onDone}/>
      <h2 style={{ fontSize:20, fontWeight:800, color:"#1e293b", margin:"0 0 20px" }}>{isNew?"Add Player":`Edit ${player.name}`}</h2>
      <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
        <div><Label>Player Name</Label><input value={name} onChange={e=>setName(e.target.value)} placeholder="Enter player name…" style={inputStyle}/></div>
        <div><Label>Clan</Label><SelField value={clan} onChange={setClan} options={CLANS.map(c=>({value:c,label:c}))} placeholder="Select clan…"/></div>
        <div>
          <Label>Levels <span style={{ textTransform:"none", fontWeight:400, color:"#94a3b8", fontSize:11 }}>(optional — can be added later)</span></Label>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            {Object.entries(LEVEL_TYPES).map(([type,cfg]) => (
              <div key={type}>
                <div style={{ fontSize:12, color:"#64748b", fontWeight:600, marginBottom:4 }}>{cfg.label}</div>
                <SelField value={levels[type]||""} onChange={v=>setLevels(prev=>({...prev,[type]:v||null}))} options={cfg.levels.map(l=>({value:l,label:l}))} placeholder="—"/>
              </div>
            ))}
          </div>
        </div>
        {error && <p style={{ fontSize:13, color:"#dc2626", margin:0, backgroundColor:"#fef2f2", padding:"10px 14px", borderRadius:8 }}>{error}</p>}
        <div style={{ display:"flex", gap:10 }}>
          <Btn onClick={onDone} variant="ghost"   size="lg" fullWidth>Cancel</Btn>
          <Btn onClick={save}   variant="primary" size="lg" fullWidth>{isNew?"Add Player":"Save Changes"}</Btn>
        </div>
      </div>
    </div>
  );
};

// ─── PLAYER DETAIL ────────────────────────────────────────────────────────────
const PlayerDetail = ({ player, onBack }) => {
  const noScoreStyle = { fontSize:13, color:"#cbd5e1", fontFamily:"'DM Mono',monospace", fontWeight:500 };

  return (
    <div style={{ padding:"0 16px 16px" }}>
      <BackBtn onBack={onBack}/>

      {/* Player header */}
      <div style={{ display:"flex", alignItems:"center", gap:14, marginBottom:20 }}>
        <div style={{ width:52, height:52, borderRadius:14, backgroundColor:"#1e293b", display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, fontWeight:800, color:"#fff", fontFamily:"'DM Mono',monospace", flexShrink:0 }}>
          {player.name[0]}
        </div>
        <div>
          <h2 style={{ fontSize:20, fontWeight:800, color:"#1e293b", margin:"0 0 4px" }}>{player.name}</h2>
          <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
            <ClanBadge clan={player.clan}/>
            {Object.keys(LEVEL_TYPES).map(t => <LevelBadge key={t} type={t} value={player.levels?.[t]}/>)}
          </div>
        </div>
      </div>

      {/* Event history */}
      <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
        {EVENT_TYPES.map(ev => {
          const scores = getPlayerEventScores(player.id, player.clan, ev.id);
          const hasData = scores.length > 0;

          return (
            <Card key={ev.id}>
              {/* Event title row */}
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
                <div>
                  <span style={{ fontSize:14, fontWeight:700, color:"#1e293b" }}>{ev.name}</span>
                  <span style={{ marginLeft:8 }}><FreqTag freq={ev.frequency}/></span>
                </div>
                {hasData && (
                  <TrendBadge trend={getTrend(scores, ev.fields[0].key)} size="lg"/>
                )}
              </div>

              {!hasData ? (
                <p style={{ fontSize:13, color:"#cbd5e1", margin:0, fontStyle:"italic" }}>No scores recorded yet</p>
              ) : (
                <>
                  {/* Column headers: last 3 dates */}
                  <div style={{ display:"grid", gridTemplateColumns:`120px repeat(${Math.min(scores.length,3)}, 1fr)`, gap:6, marginBottom:6 }}>
                    <div/>
                    {scores.slice(0,3).map((s,i) => (
                      <div key={i} style={{ fontSize:10, color:"#94a3b8", fontWeight:600, textAlign:"center", fontFamily:"'DM Mono',monospace" }}>
                        {i===0?"Latest":s.date}
                      </div>
                    ))}
                  </div>

                  {/* One row per field */}
                  {ev.fields.map(f => (
                    <div key={f.key} style={{ display:"grid", gridTemplateColumns:`120px repeat(${Math.min(scores.length,3)}, 1fr)`, gap:6, alignItems:"center", padding:"5px 0", borderTop:"1px solid #f1f5f9" }}>
                      <div style={{ fontSize:11, color:"#94a3b8", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.05em" }}>{f.label}</div>
                      {scores.slice(0,3).map((s,i) => (
                        <div key={i} style={{ textAlign:"center" }}>
                          {s.values[f.key]
                            ? <span style={{ fontSize:13, fontWeight:700, color: i===0?"#1e293b":"#94a3b8", fontFamily:"'DM Mono',monospace" }}>
                                {Number(s.values[f.key]).toLocaleString()}
                              </span>
                            : <span style={noScoreStyle}>—</span>
                          }
                        </div>
                      ))}
                      {/* Fill empty columns if fewer than 3 entries */}
                      {Array.from({ length: Math.max(0, 3 - scores.length) }).map((_,i) => (
                        <div key={`empty-${i}`} style={{ textAlign:"center" }}><span style={noScoreStyle}>—</span></div>
                      ))}
                    </div>
                  ))}
                </>
              )}
            </Card>
          );
        })}
      </div>
    </div>
  );
};

// ─── PLAYERS SCREEN ───────────────────────────────────────────────────────────
const PlayersScreen = () => {
  const [clan,        setClan]        = useState("All");
  const [showInactive,setShowInactive]= useState(false);
  const [editPlayer,  setEditPlayer]  = useState(null);
  const [viewPlayer,  setViewPlayer]  = useState(null);
  const [deactivating,setDeactivating]= useState(null);
  const forceUpdate = useForceUpdate();

  const all      = storage.getPlayers();
  const filtered = all.filter(p => (!showInactive?p.active:true) && (clan==="All"||p.clan===clan));

  const toggleActive = (p) => {
    if (p.active) { setDeactivating(p); return; }
    storage.savePlayers(all.map(x => x.id===p.id?{...x,active:true}:x));
    forceUpdate();
  };

  if (editPlayer !== null) return <PlayerForm player={editPlayer==="new"?null:editPlayer} onDone={()=>{ setEditPlayer(null); forceUpdate(); }}/>;
  if (viewPlayer  !== null) return <PlayerDetail player={viewPlayer} onBack={()=>setViewPlayer(null)}/>;

  return (
    <div style={{ padding:"0 16px 16px" }}>
      <div style={{ display:"flex", gap:8, marginBottom:16, overflowX:"auto", paddingBottom:2 }}>
        {["All",...CLANS].map(c=>(
          <button key={c} onClick={()=>setClan(c)} style={{ padding:"7px 16px", borderRadius:20, border:"none", fontSize:13, fontWeight:600, cursor:"pointer", whiteSpace:"nowrap", backgroundColor:clan===c?"#1e293b":"#f1f5f9", color:clan===c?"#fff":"#475569" }}>{c}</button>
        ))}
        <button onClick={()=>setShowInactive(!showInactive)} style={{ padding:"7px 14px", borderRadius:20, border:"1px solid #e2e8f0", fontSize:13, fontWeight:500, cursor:"pointer", whiteSpace:"nowrap", backgroundColor:showInactive?"#fef3c7":"#fff", color:"#475569", marginLeft:"auto" }}>
          {showInactive?"Hide inactive":"Show inactive"}
        </button>
      </div>

      <p style={{ fontSize:13, color:"#94a3b8", margin:"0 0 12px", fontWeight:500 }}>{filtered.length} player{filtered.length!==1?"s":""} · tap a name to view score history</p>

      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {filtered.length===0 && <EmptyState icon="players" message="No players found"/>}
        {filtered.map(p=>(
          <Card key={p.id} onClick={()=>setViewPlayer(p)} style={{ cursor:"pointer" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <div style={{ width:38, height:38, borderRadius:10, backgroundColor:p.active?"#1e293b":"#e2e8f0", display:"flex", alignItems:"center", justifyContent:"center", fontSize:15, fontWeight:700, color:p.active?"#fff":"#94a3b8", fontFamily:"'DM Mono',monospace" }}>{p.name[0]}</div>
                <div>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ fontSize:15, fontWeight:700, color:"#1e293b" }}>{p.name}</span>
                    {!p.active && <span style={{ fontSize:11, color:"#94a3b8", backgroundColor:"#f1f5f9", borderRadius:4, padding:"1px 6px" }}>Inactive</span>}
                    {p.active&&!p.levels?.G && <span style={{ fontSize:11, color:"#dc2626", backgroundColor:"#fef2f2", borderRadius:4, padding:"1px 6px" }}>Guard?</span>}
                  </div>
                  <div style={{ marginTop:3 }}><ClanBadge clan={p.clan}/></div>
                </div>
              </div>
              <div style={{ display:"flex", gap:8 }} onClick={e=>e.stopPropagation()}>
                <button onClick={()=>setEditPlayer(p)} style={{ background:"none", border:"none", cursor:"pointer", padding:6, borderRadius:8, backgroundColor:"#f8fafc" }}><Icon name="edit" size={16} color="#64748b"/></button>
                <button onClick={()=>toggleActive(p)} style={{ background:"none", border:"none", cursor:"pointer", padding:6, borderRadius:8, backgroundColor:p.active?"#fef2f2":"#f0fdf4" }}>
                  <Icon name={p.active?"userMinus":"userPlus"} size={16} color={p.active?"#dc2626":"#16a34a"}/>
                </button>
              </div>
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                {Object.keys(LEVEL_TYPES).map(t=><LevelBadge key={t} type={t} value={p.levels?.[t]}/>)}
              </div>
              <Icon name="chevR" size={14} color="#cbd5e1"/>
            </div>
          </Card>
        ))}
      </div>

      <button onClick={()=>setEditPlayer("new")} style={{ position:"fixed", bottom:84, right:20, width:52, height:52, borderRadius:16, backgroundColor:"#1e293b", border:"none", display:"flex", alignItems:"center", justifyContent:"center", boxShadow:"0 4px 16px rgba(0,0,0,0.18)", cursor:"pointer" }}>
        <Icon name="plus" size={22} color="#fff"/>
      </button>

      {deactivating && (
        <Modal
          title={`Deactivate ${deactivating.name}?`}
          message={`${deactivating.name} will be marked inactive and hidden from score entry. You can reactivate them at any time.`}
          confirmLabel="Deactivate"
          confirmVariant="danger"
          onConfirm={()=>{ storage.savePlayers(all.map(x=>x.id===deactivating.id?{...x,active:false}:x)); setDeactivating(null); forceUpdate(); }}
          onCancel={()=>setDeactivating(null)}
        />
      )}
    </div>
  );
};

// ─── BULK PASTE COMPONENT ────────────────────────────────────────────────────
const BulkPaste = ({ clan, event, onBack }) => {
  const players  = storage.getPlayers().filter(p => p.clan === clan && p.active);
  const [text,      setText]      = useState("");
  const [results,   setResults]   = useState(null); // null = not yet parsed
  const [decisions, setDecisions] = useState({});   // index → "accept" | "skip"
  const [saved,     setSaved]     = useState(false);

  // ── Parse pasted text ──
  const parse = () => {
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const nf = event.fields.length;
    const parsed = lines.map(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length < nf + 1) return { raw: line, type: "error", reason: "Too few values" };
      const rawScores = parts.slice(parts.length - nf);
      const nameParts = parts.slice(0, parts.length - nf);
      const name = nameParts.join(" ");
      const scores = {};
      let badScore = false;
      event.fields.forEach((f, i) => {
        const v = rawScores[i];
        if (!v || isNaN(Number(v)) || Number(v) < 0) badScore = true;
        else scores[f.key] = v;
      });
      if (badScore) return { raw: line, type: "error", reason: "Invalid score value" };
      const match = fuzzyMatch(name, players);
      return { raw: line, name, scores, match };
    });
    setResults(parsed);
    setDecisions({});
  };

  const decide = (i, choice) => setDecisions(d => ({ ...d, [i]: choice }));

  // ── Build summary counts ──
  const counts = results ? results.reduce((acc, r, i) => {
    if (r.type === "error")            { acc.errors++;  return acc; }
    if (r.match.type === "exact")      { acc.matched++; return acc; }
    if (r.match.type === "suggestion") {
      if (decisions[i] === "accept")   { acc.matched++; acc.resolved++; }
      else if (decisions[i] === "skip") { acc.skipped++; acc.resolved++; }
      else                              { acc.pending++; }
      return acc;
    }
    acc.unmatched++; return acc;
  }, { matched:0, skipped:0, errors:0, pending:0, unmatched:0, resolved:0 }) : null;

  const canSave = results && counts && counts.pending === 0 && counts.matched > 0;

  const save = () => {
    const finalScores = {};
    results.forEach((r, i) => {
      if (r.type === "error") return;
      if (r.match.type === "exact")
        finalScores[r.match.player.id] = r.scores;
      else if (r.match.type === "suggestion" && decisions[i] === "accept")
        finalScores[r.match.player.id] = r.scores;
    });
    if (!Object.keys(finalScores).length) return;
    const all = storage.getScores();
    const key = `${clan}_${event.id}`;
    if (!all[key]) all[key] = [];
    all[key].unshift({ date: new Date().toISOString(), scores: finalScores });
    if (all[key].length > 3) all[key] = all[key].slice(0, 3);
    storage.saveScores(all);
    setSaved(true);
    setTimeout(() => { setSaved(false); onBack(); }, 1400);
  };

  const ScorePills = ({ scores }) => (
    <div style={{ display:"flex", gap:4, flexWrap:"wrap" }}>
      {event.fields.map(f => (
        <span key={f.key} style={{ backgroundColor:"#f1f5f9", color:"#475569", borderRadius:4, padding:"2px 7px", fontSize:12, fontFamily:"'DM Mono',monospace", fontWeight:600 }}>
          {f.label}: {scores[f.key]}
        </span>
      ))}
    </div>
  );

  // ── Step 1: paste input ──
  if (!results) return (
    <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
      <p style={{ fontSize:13, color:"#64748b", margin:"0 0 4px", lineHeight:1.6 }}>
        Paste scores — one line per player:<br/>
        <code style={{ backgroundColor:"#f1f5f9", padding:"2px 8px", borderRadius:4, fontFamily:"'DM Mono',monospace", fontSize:12 }}>
          PlayerName{event.fields.map(f => ` ${f.label}`).join("")}
        </code>
      </p>
      <div style={{ backgroundColor:"#f8fafc", borderRadius:10, padding:"10px 14px", fontSize:12, color:"#94a3b8", lineHeight:1.7 }}>
        <span style={{ fontWeight:600, color:"#64748b" }}>Example ({event.name}):</span><br/>
        {event.fields.length===1 && <><code style={{ fontFamily:"'DM Mono',monospace" }}>DragonSlayer 14250</code><br/><code style={{ fontFamily:"'DM Mono',monospace" }}>IronFist 9800</code></>}
        {event.fields.length===2 && <><code style={{ fontFamily:"'DM Mono',monospace" }}>DragonSlayer 500 12</code><br/><code style={{ fontFamily:"'DM Mono',monospace" }}>NightHawk 320 8</code></>}
        {event.fields.length===3 && <><code style={{ fontFamily:"'DM Mono',monospace" }}>DragonSlayer 1200 85000 6</code><br/><code style={{ fontFamily:"'DM Mono',monospace" }}>NightHawk 980 72000 5</code></>}
      </div>
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder={`Paste ${event.name} scores here…`}
        style={{ width:"100%", minHeight:160, padding:12, borderRadius:10, border:"1.5px solid #e2e8f0", fontSize:13, color:"#1e293b", resize:"vertical", fontFamily:"'DM Mono',monospace", boxSizing:"border-box", outline:"none", lineHeight:1.7 }}
      />
      <Btn onClick={parse} variant="primary" size="lg" fullWidth disabled={!text.trim()}>
        Parse & Match
      </Btn>
    </div>
  );

  // ── Step 2: review results ──
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:10 }}>

      {/* Summary bar */}
      <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:4 }}>
        {[
          { label:"Matched",   val:counts.matched,   color:"#16a34a", bg:"#f0fdf4" },
          { label:"Review",    val:counts.pending,   color:"#d97706", bg:"#fef3c7" },
          { label:"Skipped",   val:counts.skipped + counts.unmatched, color:"#64748b", bg:"#f1f5f9" },
          { label:"Errors",    val:counts.errors,    color:"#dc2626", bg:"#fef2f2" },
        ].filter(s => s.val > 0).map(s => (
          <span key={s.label} style={{ backgroundColor:s.bg, color:s.color, borderRadius:8, padding:"4px 12px", fontSize:12, fontWeight:700 }}>
            {s.val} {s.label}
          </span>
        ))}
      </div>

      {/* Result rows */}
      {results.map((r, i) => {
        if (r.type === "error") return (
          <Card key={i} style={{ borderLeft:"3px solid #dc2626", opacity:0.7 }}>
            <div style={{ fontSize:13, color:"#dc2626", fontWeight:600, marginBottom:2 }}>Could not parse</div>
            <div style={{ fontSize:12, color:"#94a3b8", fontFamily:"'DM Mono',monospace" }}>{r.raw}</div>
            <div style={{ fontSize:11, color:"#dc2626", marginTop:4 }}>{r.reason}</div>
          </Card>
        );

        if (r.match.type === "exact") return (
          <Card key={i} style={{ borderLeft:"3px solid #16a34a" }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <Icon name="check" size={16} color="#16a34a"/>
                <span style={{ fontSize:14, fontWeight:700, color:"#1e293b" }}>{r.match.player.name}</span>
                <ClanBadge clan={r.match.player.clan}/>
              </div>
            </div>
            {r.name.toLowerCase() !== r.match.player.name.toLowerCase() &&
              <div style={{ fontSize:11, color:"#94a3b8", marginBottom:6 }}>Pasted as: <code style={{ fontFamily:"'DM Mono',monospace" }}>{r.name}</code></div>
            }
            <ScorePills scores={r.scores}/>
          </Card>
        );

        if (r.match.type === "suggestion") {
          const dec = decisions[i];
          return (
            <Card key={i} style={{ borderLeft:`3px solid ${dec==="accept"?"#16a34a":dec==="skip"?"#94a3b8":"#f59e0b"}` }}>
              <div style={{ fontSize:12, color:"#d97706", fontWeight:600, marginBottom:4 }}>
                Did you mean <strong>{r.match.player.name}</strong>?
              </div>
              <div style={{ fontSize:12, color:"#94a3b8", marginBottom:8 }}>
                Pasted as: <code style={{ fontFamily:"'DM Mono',monospace" }}>{r.name}</code>
              </div>
              <ScorePills scores={r.scores}/>
              {!dec && (
                <div style={{ display:"flex", gap:8, marginTop:10 }}>
                  <Btn onClick={()=>decide(i,"skip")}   variant="ghost"   size="sm" fullWidth><Icon name="xmark" size={13} color="#64748b"/> Skip</Btn>
                  <Btn onClick={()=>decide(i,"accept")} variant="success" size="sm" fullWidth><Icon name="check" size={13} color="#fff"/> Accept</Btn>
                </div>
              )}
              {dec && (
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:10 }}>
                  <span style={{ fontSize:12, fontWeight:700, color:dec==="accept"?"#16a34a":"#94a3b8" }}>
                    {dec==="accept" ? "✓ Accepted" : "— Skipped"}
                  </span>
                  <button onClick={()=>decide(i,null)} style={{ fontSize:11, color:"#94a3b8", background:"none", border:"none", cursor:"pointer", padding:0 }}>Undo</button>
                </div>
              )}
            </Card>
          );
        }

        // no match
        return (
          <Card key={i} style={{ borderLeft:"3px solid #e2e8f0", opacity:0.65 }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:4 }}>
              <Icon name="xmark" size={14} color="#94a3b8"/>
              <span style={{ fontSize:13, color:"#94a3b8", fontWeight:600 }}>No match — skipped</span>
            </div>
            <div style={{ fontSize:12, color:"#94a3b8", fontFamily:"'DM Mono',monospace" }}>{r.name}</div>
          </Card>
        );
      })}

      {/* Actions */}
      <div style={{ display:"flex", gap:10, marginTop:4 }}>
        <Btn onClick={() => { setResults(null); setDecisions({}); }} variant="ghost" size="lg" fullWidth>
          Re-paste
        </Btn>
        <button onClick={save} disabled={!canSave} style={{ flex:1, padding:"13px 0", borderRadius:12, border:"none", backgroundColor:saved?"#16a34a":canSave?"#1e293b":"#e2e8f0", color:saved||canSave?"#fff":"#94a3b8", fontSize:15, fontWeight:700, cursor:canSave?"pointer":"not-allowed", display:"flex", alignItems:"center", justifyContent:"center", gap:8, transition:"background-color 0.2s" }}>
          {saved ? <><Icon name="check" size={18} color="#fff"/> Saved!</> : counts.pending > 0 ? `Review ${counts.pending} left` : `Save ${counts.matched} Score${counts.matched!==1?"s":""}`}
        </button>
      </div>
    </div>
  );
};

// ─── SCORE ENTRY SCREEN ───────────────────────────────────────────────────────
const ScoreEntryScreen = () => {
  const [selClan,  setSelClan]  = useState(null);
  const [selEvent, setSelEvent] = useState(null);

  return (
    <div style={{ padding:"0 16px 16px" }}>
      {!selClan ? (
        <>
          <p style={{ fontSize:14, color:"#64748b", margin:"0 0 16px" }}>Select a clan to enter scores for.</p>
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {CLANS.map(clan=>(
              <Card key={clan} onClick={()=>setSelClan(clan)} style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div style={{ display:"flex", alignItems:"center", gap:12 }}>
                  <div style={{ width:42, height:42, borderRadius:12, backgroundColor:"#f1f5f9", display:"flex", alignItems:"center", justifyContent:"center" }}><Icon name="shield" size={20} color="#475569"/></div>
                  <div>
                    <div style={{ fontSize:17, fontWeight:700, color:"#1e293b", fontFamily:"'DM Mono',monospace" }}>{clan}</div>
                    <div style={{ fontSize:13, color:"#94a3b8", marginTop:1 }}>{storage.getPlayers().filter(p=>p.clan===clan&&p.active).length} active players</div>
                  </div>
                </div>
                <Icon name="chevR" size={18} color="#cbd5e1"/>
              </Card>
            ))}
          </div>
        </>
      ) : !selEvent ? (
        <>
          <BackBtn onBack={()=>setSelClan(null)}/>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16 }}><ClanBadge clan={selClan}/><span style={{ fontSize:15, fontWeight:600, color:"#1e293b" }}>Select Event</span></div>
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {EVENT_TYPES.map(ev=>(
              <Card key={ev.id} onClick={()=>setSelEvent(ev)} style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div>
                  <div style={{ fontSize:15, fontWeight:700, color:"#1e293b" }}>{ev.name}</div>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginTop:6 }}>
                    <FreqTag freq={ev.frequency}/>
                    <span style={{ fontSize:12, color:"#94a3b8" }}>{ev.fields.map(f=>f.label).join(" · ")}</span>
                  </div>
                </div>
                <Icon name="chevR" size={18} color="#cbd5e1"/>
              </Card>
            ))}
          </div>
        </>
      ) : (
        <ScoreForm clan={selClan} event={selEvent} onBack={()=>setSelEvent(null)}/>
      )}
    </div>
  );
};

const ScoreForm = ({ clan, event, onBack }) => {
  const players     = storage.getPlayers().filter(p=>p.clan===clan&&p.active);
  const [scores,    setScores]    = useState({});
  const [mode,      setMode]      = useState("manual");
  const [saved,     setSaved]     = useState(false);
  const [errors,    setErrors]    = useState({});
  const [attempted, setAttempted] = useState(false);

  // Count players with all fields filled
  const scored = players.filter(p =>
    event.fields.every(f => { const v = scores[p.id]?.[f.key]; return v !== undefined && v !== ""; })
  ).length;

  const update = (pid, key, val) => {
    setScores(prev => ({ ...prev, [pid]: { ...prev[pid], [key]: val } }));
    if (attempted) {
      setErrors(prev => {
        const next = { ...prev };
        if (next[pid]) { delete next[pid][key]; if (!Object.keys(next[pid]).length) delete next[pid]; }
        return next;
      });
    }
  };

  const validate = () => {
    const errs = {};
    let anyFilled = false;
    players.forEach(p => {
      event.fields.forEach(f => {
        const v = scores[p.id]?.[f.key];
        const filled = v !== undefined && v !== "";
        if (filled) anyFilled = true;
        if (filled && (isNaN(Number(v)) || Number(v) < 0)) {
          if (!errs[p.id]) errs[p.id] = {};
          errs[p.id][f.key] = true;
        }
      });
    });
    if (!anyFilled) return null; // nothing entered at all
    return errs;
  };

  const save = () => {
    setAttempted(true);
    const errs = validate();
    if (errs === null)                 { setErrors({ _empty: true }); return; }
    if (Object.keys(errs).length > 0)  { setErrors(errs); return; }
    const all = storage.getScores();
    const key = `${clan}_${event.id}`;
    if (!all[key]) all[key] = [];
    all[key].unshift({ date: new Date().toISOString(), scores });
    if (all[key].length > 3) all[key] = all[key].slice(0, 3);
    storage.saveScores(all);
    setSaved(true);
    setTimeout(() => { setSaved(false); onBack(); }, 1200);
  };

  const fieldBorder = (pid, key) => errors[pid]?.[key] ? "#dc2626" : "#e2e8f0";
  const fieldBg     = (pid, key) => errors[pid]?.[key] ? "#fef2f2"  : "#fff";

  return (
    <div>
      <BackBtn onBack={onBack}/>
      <div style={{ marginBottom:16 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
          <ClanBadge clan={clan}/>
          <span style={{ fontSize:17, fontWeight:700, color:"#1e293b" }}>{event.name}</span>
        </div>
        <FreqTag freq={event.frequency}/>
      </div>

      <div style={{ display:"flex", backgroundColor:"#f1f5f9", borderRadius:10, padding:3, marginBottom:16 }}>
        {["manual","bulk"].map(m=>(
          <button key={m} onClick={()=>setMode(m)} style={{ flex:1, padding:"8px 0", borderRadius:8, border:"none", cursor:"pointer", fontSize:13, fontWeight:600, backgroundColor:mode===m?"#fff":"transparent", color:mode===m?"#1e293b":"#94a3b8", boxShadow:mode===m?"0 1px 3px rgba(0,0,0,0.08)":"none" }}>
            {m==="manual"?"Manual Entry":"Bulk Paste"}
          </button>
        ))}
      </div>

      {mode==="manual" ? (
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>

          {/* Progress counter */}
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:2 }}>
            <span style={{ fontSize:12, color:"#94a3b8", fontWeight:500 }}>
              {scored} of {players.length} players scored
            </span>
            {scored===players.length && players.length>0 &&
              <span style={{ fontSize:12, color:"#16a34a", fontWeight:700 }}>✓ All entered</span>
            }
          </div>

          {/* Validation banners */}
          {errors._empty && (
            <div style={{ backgroundColor:"#fef3c7", borderRadius:10, padding:"10px 14px", fontSize:13, color:"#92400e", fontWeight:500 }}>
              Enter at least one score before saving.
            </div>
          )}
          {Object.keys(errors).filter(k=>k!=="__empty").some(k=>k!=="_empty") && !errors._empty && (
            <div style={{ backgroundColor:"#fef2f2", borderRadius:10, padding:"10px 14px", fontSize:13, color:"#dc2626", fontWeight:500 }}>
              Some scores are invalid — positive numbers only.
            </div>
          )}

          {players.map(p=>(
            <Card key={p.id}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:event.fields.length>1?10:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <div style={{ width:32, height:32, borderRadius:8, backgroundColor:"#1e293b", display:"flex", alignItems:"center", justifyContent:"center", fontSize:13, fontWeight:700, color:"#fff" }}>{p.name[0]}</div>
                  <span style={{ fontSize:14, fontWeight:600, color:"#1e293b" }}>{p.name}</span>
                </div>
                {event.fields.length===1 && (
                  <input
                    type="number"
                    placeholder="—"
                    min="0"
                    value={scores[p.id]?.[event.fields[0].key]||""}
                    onChange={e=>update(p.id,event.fields[0].key,e.target.value)}
                    style={{ width:90, padding:"8px 12px", borderRadius:8, border:`1.5px solid ${fieldBorder(p.id,event.fields[0].key)}`, backgroundColor:fieldBg(p.id,event.fields[0].key), fontSize:15, fontWeight:600, textAlign:"right", color:"#1e293b", outline:"none", fontFamily:"'DM Mono',monospace" }}
                  />
                )}
              </div>
              {event.fields.length>1 && (
                <div style={{ display:"flex", gap:8 }}>
                  {event.fields.map(f=>(
                    <div key={f.key} style={{ flex:1 }}>
                      <div style={{ fontSize:11, color:errors[p.id]?.[f.key]?"#dc2626":"#94a3b8", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4 }}>{f.label}</div>
                      <input
                        type="number"
                        placeholder="—"
                        min="0"
                        value={scores[p.id]?.[f.key]||""}
                        onChange={e=>update(p.id,f.key,e.target.value)}
                        style={{ width:"100%", padding:"8px 10px", borderRadius:8, border:`1.5px solid ${fieldBorder(p.id,f.key)}`, backgroundColor:fieldBg(p.id,f.key), fontSize:14, fontWeight:600, color:"#1e293b", boxSizing:"border-box", outline:"none", fontFamily:"'DM Mono',monospace" }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ))}

          <button onClick={save} style={{ marginTop:6, width:"100%", padding:"14px 0", borderRadius:12, border:"none", backgroundColor:saved?"#16a34a":"#1e293b", color:"#fff", fontSize:15, fontWeight:700, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8, transition:"background-color 0.2s" }}>
            {saved ? <><Icon name="check" size={18} color="#fff"/> Saved!</> : `Save Scores (${scored}/${players.length})`}
          </button>
        </div>
      ) : (
        <BulkPaste clan={clan} event={event} onBack={onBack}/>
      )}
    </div>
  );
};

// ─── TRENDS SCREEN ────────────────────────────────────────────────────────────
const TrendsScreen = () => {
  const [clan,         setClan]         = useState("69R");
  const [viewPlayer,   setViewPlayer]   = useState(null);
  const [nameFilter,   setNameFilter]   = useState("");
  const [hiddenEvents, setHiddenEvents] = useState(new Set());
  const [sortBy,       setSortBy]       = useState("name");
  const [sortDir,      setSortDir]      = useState("asc");

  if (viewPlayer) return <PlayerDetail player={viewPlayer} onBack={()=>setViewPlayer(null)}/>;

  const allPlayers    = storage.getPlayers().filter(p => p.clan === clan && p.active);
  const visibleEvents = EVENT_TYPES.filter(ev => !hiddenEvents.has(ev.id));

  const toggleEvent = evId =>
    setHiddenEvents(prev => { const s = new Set(prev); s.has(evId) ? s.delete(evId) : s.add(evId); return s; });

  const handleSort = evId => {
    if (sortBy === evId) setSortDir(d => d === "desc" ? "asc" : "desc");
    else { setSortBy(evId); setSortDir("desc"); }
  };

  // Build enriched player rows with cached scores
  const enriched = allPlayers.map(p => {
    const evScores = {};
    EVENT_TYPES.forEach(ev => {
      const s = getPlayerEventScores(p.id, clan, ev.id);
      evScores[ev.id] = { scores: s, latest: s[0]?.values[ev.fields[0].key], trend: getTrend(s, ev.fields[0].key) };
    });
    return { player: p, evScores };
  });

  // Filter by name
  const filtered = nameFilter.trim()
    ? enriched.filter(r => r.player.name.toLowerCase().includes(nameFilter.toLowerCase()))
    : enriched;

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "name") {
      const cmp = a.player.name.localeCompare(b.player.name);
      return sortDir === "asc" ? cmp : -cmp;
    }
    const av = Number(a.evScores[sortBy]?.latest ?? -1);
    const bv = Number(b.evScores[sortBy]?.latest ?? -1);
    return sortDir === "desc" ? bv - av : av - bv;
  });

  const NAME_W = 130;
  const COL_W  = 54;

  return (
    <div style={{ padding:"0 16px 16px" }}>
      {/* Clan tabs */}
      <div style={{ display:"flex", gap:8, marginBottom:14 }}>
        {CLANS.map(c => (
          <button key={c} onClick={()=>{ setClan(c); setSortBy("name"); setSortDir("asc"); }}
            style={{ flex:1, padding:"9px 0", borderRadius:20, border:"none", fontSize:13, fontWeight:700, cursor:"pointer", fontFamily:"'DM Mono',monospace", backgroundColor:clan===c?"#1e293b":"#f1f5f9", color:clan===c?"#fff":"#475569" }}>
            {c}
          </button>
        ))}
      </div>

      {/* Name filter */}
      <div style={{ position:"relative", marginBottom:12 }}>
        <input
          value={nameFilter}
          onChange={e => setNameFilter(e.target.value)}
          placeholder="Filter by player name…"
          style={{ width:"100%", padding:"10px 14px 10px 36px", borderRadius:10, border:"1.5px solid #e2e8f0", fontSize:13, color:"#1e293b", outline:"none", backgroundColor:"#fff", fontFamily:"'Outfit',system-ui,sans-serif", boxSizing:"border-box" }}
        />
        <div style={{ position:"absolute", left:11, top:"50%", transform:"translateY(-50%)", pointerEvents:"none" }}>
          <Icon name="players" size={15} color="#94a3b8"/>
        </div>
        {nameFilter && (
          <button onClick={()=>setNameFilter("")} style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", cursor:"pointer", padding:4, color:"#94a3b8", fontSize:14, lineHeight:1 }}>✕</button>
        )}
      </div>

      {/* Event column toggles */}
      <div style={{ display:"flex", gap:6, marginBottom:14, overflowX:"auto", paddingBottom:2 }}>
        {EVENT_TYPES.map(ev => {
          const hidden = hiddenEvents.has(ev.id);
          return (
            <button key={ev.id} onClick={()=>toggleEvent(ev.id)}
              style={{ flexShrink:0, padding:"5px 12px", borderRadius:16, border:`1.5px solid ${hidden?"#e2e8f0":"#1e293b"}`, fontSize:11, fontWeight:700, cursor:"pointer", backgroundColor:hidden?"#f8fafc":"#1e293b", color:hidden?"#94a3b8":"#fff", fontFamily:"'DM Mono',monospace" }}>
              {abbrev(ev.name)}
            </button>
          );
        })}
      </div>

      {allPlayers.length === 0 && <EmptyState icon="trends" message="No active players in this clan"/>}
      {allPlayers.length > 0 && sorted.length === 0 && <EmptyState icon="players" message="No players match that name"/>}

      {sorted.length > 0 && (
        <div style={{ backgroundColor:"#fff", borderRadius:14, boxShadow:"0 1px 4px rgba(0,0,0,0.07),0 0 0 1px rgba(0,0,0,0.04)", overflow:"hidden" }}>
          <div style={{ overflowX:"auto", WebkitOverflowScrolling:"touch" }}>
            <div style={{ minWidth: NAME_W + visibleEvents.length * COL_W }}>

              {/* Header row */}
              <div style={{ display:"flex", alignItems:"center", backgroundColor:"#f8fafc", borderBottom:"2px solid #e2e8f0", padding:"8px 0" }}>
                <div
                  onClick={()=>handleSort("name")}
                  style={{ width:NAME_W, flexShrink:0, paddingLeft:14, fontSize:10, fontWeight:700, color:sortBy==="name"?"#1e293b":"#94a3b8", textTransform:"uppercase", letterSpacing:"0.08em", cursor:"pointer", userSelect:"none" }}>
                  Player {sortBy==="name" ? (sortDir==="asc"?"↑":"↓") : ""}
                </div>
                {visibleEvents.map(ev => (
                  <div
                    key={ev.id}
                    onClick={()=>handleSort(ev.id)}
                    style={{ width:COL_W, flexShrink:0, textAlign:"center", fontSize:10, fontWeight:700, color:sortBy===ev.id?"#1e293b":"#94a3b8", textTransform:"uppercase", letterSpacing:"0.06em", cursor:"pointer", userSelect:"none", lineHeight:1.3 }}>
                    {abbrev(ev.name)}{sortBy===ev.id ? (sortDir==="desc"?" ↓":" ↑") : ""}
                  </div>
                ))}
              </div>

              {/* Player rows */}
              {sorted.map(({ player: p, evScores }, i) => (
                <div
                  key={p.id}
                  onClick={()=>setViewPlayer(p)}
                  style={{ display:"flex", alignItems:"center", padding:"9px 0", borderBottom: i < sorted.length-1 ? "1px solid #f1f5f9" : "none", cursor:"pointer" }}>
                  {/* Name cell */}
                  <div style={{ width:NAME_W, flexShrink:0, paddingLeft:14, paddingRight:8 }}>
                    <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                      <div style={{ width:26, height:26, borderRadius:7, backgroundColor:"#1e293b", display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, fontWeight:800, color:"#fff", flexShrink:0 }}>{p.name[0]}</div>
                      <span style={{ fontSize:12, fontWeight:600, color:"#1e293b", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                        {p.name.length > 11 ? p.name.slice(0, 11) + "…" : p.name}
                      </span>
                    </div>
                  </div>
                  {/* Score cells */}
                  {visibleEvents.map(ev => {
                    const { latest, trend } = evScores[ev.id];
                    return (
                      <div key={ev.id} style={{ width:COL_W, flexShrink:0, textAlign:"center" }}>
                        <TrendBadge trend={trend}/>
                        <div style={{ fontSize:9, color:"#94a3b8", marginTop:2, fontFamily:"'DM Mono',monospace", fontWeight:600 }}>
                          {formatScore(latest)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}

            </div>
          </div>

          {/* Footer hint */}
          <div style={{ borderTop:"1px solid #f1f5f9", padding:"8px 14px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <span style={{ fontSize:11, color:"#94a3b8" }}>{sorted.length} player{sorted.length!==1?"s":""}</span>
            <span style={{ fontSize:11, color:"#cbd5e1" }}>Tap a player for full history</span>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── UPDATE LEVEL SCREEN ──────────────────────────────────────────────────────
const UpdateLevelScreen = () => {
  const [clan,      setClan]      = useState("");
  const [playerId,  setPlayerId]  = useState("");
  const [levelType, setLevelType] = useState("");
  const [newLevel,  setNewLevel]  = useState("");
  const [submitted, setSubmitted] = useState(false);
  const forceUpdate = useForceUpdate();

  const players    = storage.getPlayers().filter(p=>p.clan===clan&&p.active);
  const player     = players.find(p=>p.id===playerId);
  const currentLvl = player?.levels?.[levelType];

  const submit = () => {
    if (!playerId||!levelType||!newLevel) return;
    storage.saveLevelRequests([...storage.getLevelRequests(), {
      id:uid(), playerId, playerName:player.name, clan, levelType,
      from:currentLvl||"—", to:newLevel, status:"pending", date:today()
    }]);
    setSubmitted(true);
    forceUpdate();
  };

  const reset = () => { setClan(""); setPlayerId(""); setLevelType(""); setNewLevel(""); setSubmitted(false); };

  if (submitted) return (
    <div style={{ padding:"0 16px 16px", display:"flex", flexDirection:"column", alignItems:"center", textAlign:"center", paddingTop:48 }}>
      <div style={{ width:64, height:64, borderRadius:20, backgroundColor:"#f0fdf4", display:"flex", alignItems:"center", justifyContent:"center", marginBottom:16 }}>
        <Icon name="check" size={30} color="#16a34a"/>
      </div>
      <h2 style={{ fontSize:22, fontWeight:800, color:"#1e293b", margin:"0 0 8px" }}>Request Sent!</h2>
      <p style={{ fontSize:14, color:"#64748b", margin:"0 0 20px", lineHeight:1.5 }}>Your request has been submitted.<br/>An admin will review and approve it shortly.</p>
      <div style={{ backgroundColor:"#f8fafc", borderRadius:12, padding:"14px 20px", marginBottom:24, width:"100%" }}>
        <div style={{ fontSize:13, color:"#64748b", marginBottom:6 }}>Request summary</div>
        <div style={{ fontSize:15, fontWeight:700, color:"#1e293b", marginBottom:8 }}>{player?.name} · {LEVEL_TYPES[levelType]?.label}</div>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}>
          <LevelBadge type={levelType} value={currentLvl}/>
          <Icon name="arrowR" size={14} color="#94a3b8"/>
          <LevelBadge type={levelType} value={newLevel}/>
        </div>
      </div>
      <Btn onClick={reset} variant="ghost" size="lg">Submit Another</Btn>
    </div>
  );

  return (
    <div style={{ padding:"0 16px 16px" }}>
      <p style={{ fontSize:14, color:"#64748b", margin:"0 0 20px", lineHeight:1.5 }}>Select your clan and name, then submit a level update request. An admin will approve it.</p>
      <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
        <div><Label>Your Clan</Label><SelField value={clan} onChange={v=>{ setClan(v); setPlayerId(""); setLevelType(""); setNewLevel(""); }} options={CLANS.map(c=>({value:c,label:c}))} placeholder="Select your clan…"/></div>
        {clan && <div><Label>Your Name</Label><SelField value={playerId} onChange={v=>{ setPlayerId(v); setLevelType(""); setNewLevel(""); }} options={players.map(p=>({value:p.id,label:p.name}))} placeholder="Select your name…"/></div>}
        {playerId && (
          <div>
            <Label>Level Type</Label>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              {Object.entries(LEVEL_TYPES).map(([type,cfg])=>(
                <button key={type} onClick={()=>{ setLevelType(type); setNewLevel(""); }} style={{ padding:"12px 10px", borderRadius:10, border:`2px solid ${levelType===type?"#1e293b":"#e2e8f0"}`, backgroundColor:levelType===type?"#1e293b":"#fff", cursor:"pointer", textAlign:"left" }}>
                  <div style={{ fontSize:13, fontWeight:700, color:levelType===type?"#fff":"#1e293b" }}>{cfg.label}</div>
                  <div style={{ marginTop:4 }}><LevelBadge type={type} value={player?.levels?.[type]}/></div>
                </button>
              ))}
            </div>
          </div>
        )}
        {levelType && (
          <div>
            <Label>New Level</Label>
            {currentLvl && <p style={{ fontSize:13, color:"#64748b", margin:"0 0 8px" }}>Current: <LevelBadge type={levelType} value={currentLvl}/></p>}
            <SelField value={newLevel} onChange={setNewLevel} options={LEVEL_TYPES[levelType].levels.filter(l=>l!==currentLvl).map(l=>({value:l,label:l}))} placeholder="Select new level…"/>
          </div>
        )}
        <Btn onClick={submit} variant="primary" size="lg" fullWidth disabled={!playerId||!levelType||!newLevel}>Submit Request</Btn>
      </div>
    </div>
  );
};

// ─── LEVEL REQUESTS VIEW ──────────────────────────────────────────────────────
const LevelRequestsView = ({ onBack }) => {
  const forceUpdate = useForceUpdate();
  const all      = storage.getLevelRequests();
  const pending  = all.filter(r=>r.status==="pending");
  const resolved = all.filter(r=>r.status!=="pending");

  const approve = (id) => {
    const reqs = storage.getLevelRequests();
    const req  = reqs.find(r=>r.id===id);
    storage.savePlayers(storage.getPlayers().map(p=>p.id===req.playerId?{...p,levels:{...p.levels,[req.levelType]:req.to}}:p));
    storage.saveLevelRequests(reqs.map(r=>r.id===id?{...r,status:"approved",resolvedDate:today()}:r));
    forceUpdate();
  };

  const reject = (id) => {
    storage.saveLevelRequests(storage.getLevelRequests().map(r=>r.id===id?{...r,status:"rejected",resolvedDate:today()}:r));
    forceUpdate();
  };

  return (
    <div style={{ padding:"0 16px 16px" }}>
      <BackBtn onBack={onBack}/>
      <h2 style={{ fontSize:20, fontWeight:800, color:"#1e293b", margin:"0 0 20px" }}>Level Requests</h2>
      {all.length===0 && <EmptyState icon="bell" message="No level requests yet"/>}
      {pending.length>0 && (
        <>
          <SecHeader title={`Pending (${pending.length})`}/>
          <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:20 }}>
            {pending.map(req=>(
              <Card key={req.id}>
                <div style={{ marginBottom:12 }}>
                  <div style={{ fontSize:15, fontWeight:700, color:"#1e293b", marginBottom:6 }}>{req.playerName}</div>
                  <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                    <ClanBadge clan={req.clan}/>
                    <span style={{ fontSize:12, color:"#64748b" }}>{LEVEL_TYPES[req.levelType]?.label}:</span>
                    <LevelBadge type={req.levelType} value={req.from}/>
                    <Icon name="arrowR" size={11} color="#94a3b8"/>
                    <LevelBadge type={req.levelType} value={req.to}/>
                  </div>
                  <div style={{ fontSize:11, color:"#94a3b8", marginTop:4 }}>{req.date}</div>
                </div>
                <div style={{ display:"flex", gap:8 }}>
                  <Btn onClick={()=>reject(req.id)}  variant="ghost"   size="sm" fullWidth><Icon name="xmark" size={14} color="#64748b"/> Reject</Btn>
                  <Btn onClick={()=>approve(req.id)} variant="success" size="sm" fullWidth><Icon name="check" size={14} color="#fff"/> Approve</Btn>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
      {resolved.length>0 && (
        <>
          <SecHeader title="History"/>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {resolved.slice(0,8).map(req=>(
              <Card key={req.id} style={{ opacity:0.75 }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                  <div>
                    <div style={{ fontSize:14, fontWeight:600, color:"#1e293b", marginBottom:4 }}>{req.playerName} · {LEVEL_TYPES[req.levelType]?.label}</div>
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <LevelBadge type={req.levelType} value={req.from}/>
                      <Icon name="arrowR" size={11} color="#94a3b8"/>
                      <LevelBadge type={req.levelType} value={req.to}/>
                    </div>
                  </div>
                  <span style={{ fontSize:11, fontWeight:700, color:req.status==="approved"?"#16a34a":"#dc2626", backgroundColor:req.status==="approved"?"#f0fdf4":"#fef2f2", padding:"3px 10px", borderRadius:8 }}>{req.status}</span>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

// ─── ROTATION VIEW ────────────────────────────────────────────────────────────
const RotationView = ({ onBack, onLog }) => {
  const [playerId,setPlayerId] = useState("");
  const [toClan,  setToClan]   = useState("");
  const [confirm, setConfirm]  = useState(false);
  const forceUpdate = useForceUpdate();
  const all    = storage.getPlayers();
  const player = all.find(p=>p.id===playerId);
  const avail  = CLANS.filter(c=>c!==player?.clan);

  const rotate = () => {
    storage.savePlayers(all.map(p=>p.id===playerId?{...p,clan:toClan}:p));
    storage.saveRotationLog([{ id:uid(), playerId, playerName:player.name, fromClan:player.clan, toClan, date:today() }, ...storage.getRotationLog()]);
    setConfirm(false); setPlayerId(""); setToClan(""); forceUpdate();
  };

  return (
    <div style={{ padding:"0 16px 16px" }}>
      <BackBtn onBack={onBack}/>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
        <h2 style={{ fontSize:20, fontWeight:800, color:"#1e293b", margin:0 }}>Player Rotation</h2>
        <Btn onClick={onLog} variant="ghost" size="sm"><Icon name="history" size={14} color="#475569"/> Log</Btn>
      </div>
      <p style={{ fontSize:13, color:"#64748b", margin:"0 0 20px", lineHeight:1.5 }}>Move a player to a different clan. Score history moves with them and the rotation is logged.</p>
      <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
        <div><Label>Player</Label><SelField value={playerId} onChange={v=>{ setPlayerId(v); setToClan(""); }} options={all.filter(p=>p.active).map(p=>({value:p.id,label:`${p.name} (${p.clan})`}))} placeholder="Select player…"/></div>
        {player && (
          <>
            <div style={{ backgroundColor:"#f8fafc", borderRadius:10, padding:"10px 14px", display:"flex", alignItems:"center", gap:8 }}>
              <span style={{ fontSize:13, color:"#64748b" }}>Currently in:</span><ClanBadge clan={player.clan}/>
            </div>
            <div><Label>Move To</Label><SelField value={toClan} onChange={setToClan} options={avail.map(c=>({value:c,label:c}))} placeholder="Select destination clan…"/></div>
          </>
        )}
        <Btn onClick={()=>setConfirm(true)} variant="primary" size="lg" fullWidth disabled={!playerId||!toClan}>
          <Icon name="rotate" size={17} color="#fff"/> Rotate Player
        </Btn>
      </div>
      {confirm && <Modal title={`Move ${player?.name} to ${toClan}?`} message={`${player?.name} will be moved from ${player?.clan} to ${toClan}. Score history transfers. This rotation will be logged.`} confirmLabel="Confirm Rotation" confirmVariant="primary" onConfirm={rotate} onCancel={()=>setConfirm(false)}/>}
    </div>
  );
};

const RotationLogView = ({ onBack }) => {
  const log = storage.getRotationLog();
  return (
    <div style={{ padding:"0 16px 16px" }}>
      <BackBtn onBack={onBack}/>
      <h2 style={{ fontSize:20, fontWeight:800, color:"#1e293b", margin:"0 0 20px" }}>Rotation History</h2>
      {log.length===0 ? <EmptyState icon="history" message="No rotations recorded yet"/> : (
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {log.map(e=>(
            <Card key={e.id}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div>
                  <div style={{ fontSize:15, fontWeight:700, color:"#1e293b", marginBottom:6 }}>{e.playerName}</div>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}><ClanBadge clan={e.fromClan}/><Icon name="arrowR" size={14} color="#94a3b8"/><ClanBadge clan={e.toClan}/></div>
                </div>
                <span style={{ fontSize:12, color:"#94a3b8" }}>{e.date}</span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── IMPORT VIEW ──────────────────────────────────────────────────────────────
const ImportView = ({ onBack, onImported }) => {
  const fileRef = useRef(null);
  const [stage,   setStage]   = useState("pick");   // pick | preview | error | done
  const [preview, setPreview] = useState(null);
  const [errMsg,  setErrMsg]  = useState("");

  const readFile = e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        // Validate required keys
        if (!Array.isArray(data.players))       throw new Error("Missing or invalid 'players' array.");
        if (typeof data.scores !== "object")    throw new Error("Missing or invalid 'scores' object.");
        setPreview(data);
        setStage("preview");
      } catch(err) {
        setErrMsg(err.message || "Could not parse file.");
        setStage("error");
      }
    };
    reader.readAsText(file);
  };

  const confirmImport = () => {
    window._appData = {
      players:       preview.players       || [],
      scores:        preview.scores        || {},
      levelRequests: preview.levelRequests || [],
      rotationLog:   preview.rotationLog   || [],
      lastBackup:    storage.getLastBackup(),
    };
    setStage("done");
    setTimeout(() => onImported(), 1200);
  };

  const scoreEntryCount = preview ? Object.values(preview.scores || {}).reduce((a,v) => a + (v?.length||0), 0) : 0;
  const exportDate      = preview?.exportedAt ? new Date(preview.exportedAt).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit" }) : "Unknown";

  return (
    <div style={{ padding:"0 16px 16px" }}>
      <BackBtn onBack={onBack}/>
      <h2 style={{ fontSize:20, fontWeight:800, color:"#1e293b", margin:"0 0 6px" }}>Import Backup</h2>
      <p style={{ fontSize:13, color:"#64748b", margin:"0 0 20px", lineHeight:1.5 }}>
        Select a JSON backup file. Your current data will be replaced after you confirm.
      </p>

      {/* Hidden file input */}
      <input ref={fileRef} type="file" accept=".json,application/json" onChange={readFile} style={{ display:"none" }}/>

      {stage === "pick" && (
        <Btn onClick={()=>fileRef.current?.click()} variant="primary" size="lg" fullWidth>
          <Icon name="upload" size={17} color="#fff"/> Choose File
        </Btn>
      )}

      {stage === "error" && (
        <>
          <div style={{ backgroundColor:"#fef2f2", borderRadius:12, padding:"14px 16px", marginBottom:16 }}>
            <div style={{ fontSize:14, fontWeight:700, color:"#dc2626", marginBottom:4 }}>Invalid file</div>
            <div style={{ fontSize:13, color:"#dc2626" }}>{errMsg}</div>
          </div>
          <Btn onClick={()=>{ setStage("pick"); if(fileRef.current) fileRef.current.value=""; }} variant="ghost" size="lg" fullWidth>Try Again</Btn>
        </>
      )}

      {stage === "preview" && preview && (
        <>
          <div style={{ backgroundColor:"#f8fafc", borderRadius:12, padding:"16px", marginBottom:20 }}>
            <div style={{ fontSize:12, fontWeight:700, color:"#94a3b8", textTransform:"uppercase", letterSpacing:"0.08em", marginBottom:12 }}>Backup Preview</div>
            {[
              { label:"Players",        value: preview.players.length },
              { label:"Score entries",  value: scoreEntryCount },
              { label:"Level requests", value: (preview.levelRequests || []).length },
              { label:"Rotations",      value: (preview.rotationLog   || []).length },
              { label:"Exported",       value: exportDate },
            ].map(row => (
              <div key={row.label} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"7px 0", borderBottom:"1px solid #f1f5f9" }}>
                <span style={{ fontSize:13, color:"#64748b" }}>{row.label}</span>
                <span style={{ fontSize:13, fontWeight:700, color:"#1e293b", fontFamily:"'DM Mono',monospace" }}>{row.value}</span>
              </div>
            ))}
          </div>
          <div style={{ backgroundColor:"#fef3c7", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#92400e" }}>
            ⚠️ This will overwrite all current data. This cannot be undone.
          </div>
          <div style={{ display:"flex", gap:10 }}>
            <Btn onClick={()=>{ setStage("pick"); if(fileRef.current) fileRef.current.value=""; }} variant="ghost" size="lg" fullWidth>Cancel</Btn>
            <Btn onClick={confirmImport} variant="primary" size="lg" fullWidth>Confirm Import</Btn>
          </div>
        </>
      )}

      {stage === "done" && (
        <div style={{ textAlign:"center", padding:"32px 0" }}>
          <div style={{ width:60, height:60, borderRadius:18, backgroundColor:"#f0fdf4", display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 12px" }}>
            <Icon name="check" size={28} color="#16a34a"/>
          </div>
          <div style={{ fontSize:18, fontWeight:800, color:"#1e293b" }}>Import complete!</div>
        </div>
      )}
    </div>
  );
};

// ─── ADMIN SCREEN ─────────────────────────────────────────────────────────────
const AdminScreen = () => {
  const [view,         setView]         = useState("home");
  const [clearConfirm, setClearConfirm] = useState(false);
  const forceUpdate = useForceUpdate();

  const doExport = () => {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      players:       storage.getPlayers(),
      scores:        storage.getScores(),
      levelRequests: storage.getLevelRequests(),
      rotationLog:   storage.getRotationLog(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type:"application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `69ChestTracker_${today()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    storage.saveLastBackup(new Date().toISOString());
    forceUpdate();
  };

  const doReset = () => {
    window._appData = { players:[], scores:{}, levelRequests:[], rotationLog:[], lastBackup:null };
    setClearConfirm(false);
    forceUpdate();
  };

  if (view==="addPlayer") return <PlayerForm player={null} onDone={()=>{ setView("home"); forceUpdate(); }}/>;
  if (view==="rotation")  return <RotationView onBack={()=>{ setView("home"); forceUpdate(); }} onLog={()=>setView("rotLog")}/>;
  if (view==="rotLog")    return <RotationLogView onBack={()=>setView("rotation")}/>;
  if (view==="requests")  return <LevelRequestsView onBack={()=>{ setView("home"); forceUpdate(); }}/>;
  if (view==="import")    return <ImportView onBack={()=>setView("home")} onImported={()=>{ setView("home"); forceUpdate(); }}/>;

  const { pending, missingGuard, total } = getActionItems();
  const activePlayers = storage.getPlayers().filter(p=>p.active).length;
  const lastBackup    = storage.getLastBackup();

  const fmtBackup = ts => {
    if (!ts) return "Never";
    const d = new Date(ts);
    return d.toLocaleDateString("en-GB", { day:"numeric", month:"short" }) + " at " + d.toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit" });
  };

  return (
    <div style={{ padding:"0 16px 16px" }}>
      {/* Stats */}
      <div style={{ display:"flex", gap:10, marginBottom:20 }}>
        {[{label:"Active",value:activePlayers,color:"#3b82f6"},{label:"Clans",value:3,color:"#8b5cf6"},{label:"Events",value:EVENT_TYPES.length,color:"#f59e0b"}].map(s=>(
          <div key={s.label} style={{ flex:1, backgroundColor:"#fff", borderRadius:12, padding:"14px 8px", textAlign:"center", boxShadow:"0 1px 4px rgba(0,0,0,0.06),0 0 0 1px rgba(0,0,0,0.04)" }}>
            <div style={{ fontSize:24, fontWeight:800, color:"#1e293b", fontFamily:"'DM Mono',monospace" }}>{s.value}</div>
            <div style={{ fontSize:10, color:"#94a3b8", fontWeight:600, marginTop:2 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Action Required */}
      {total>0 && (
        <div style={{ marginBottom:20 }}>
          <SecHeader title={`Action Required (${total})`}/>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {pending.map(req=>(
              <Card key={req.id} onClick={()=>setView("requests")} style={{ borderLeft:"3px solid #f59e0b" }}>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <div style={{ width:36, height:36, borderRadius:10, backgroundColor:"#fef3c7", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}><Icon name="levelUp" size={17} color="#d97706"/></div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:14, fontWeight:700, color:"#1e293b" }}>Level Request — {req.playerName}</div>
                    <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:3, flexWrap:"wrap" }}>
                      <ClanBadge clan={req.clan}/>
                      <span style={{ fontSize:12, color:"#64748b" }}>{LEVEL_TYPES[req.levelType]?.label}:</span>
                      <LevelBadge type={req.levelType} value={req.from}/>
                      <Icon name="arrowR" size={11} color="#94a3b8"/>
                      <LevelBadge type={req.levelType} value={req.to}/>
                    </div>
                  </div>
                  <Icon name="chevR" size={16} color="#cbd5e1"/>
                </div>
              </Card>
            ))}
            {missingGuard.map(p=>(
              <Card key={p.id} style={{ borderLeft:"3px solid #dc2626" }}>
                <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                  <div style={{ width:36, height:36, borderRadius:10, backgroundColor:"#fef2f2", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}><Icon name="warning" size={17} color="#dc2626"/></div>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:14, fontWeight:700, color:"#1e293b" }}>Missing Guard Level — {p.name}</div>
                    <div style={{ marginTop:3 }}><ClanBadge clan={p.clan}/></div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Player Management */}
      <div style={{ marginBottom:20 }}>
        <SecHeader title="Player Management"/>
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          {[
            { icon:"userPlus", label:"Add New Player",   sub:"Add a player to a clan",    color:"#3b82f6", action:()=>setView("addPlayer") },
            { icon:"rotate",   label:"Player Rotation",  sub:"Move players between clans", color:"#f59e0b", action:()=>setView("rotation")  },
            { icon:"history",  label:"Rotation History", sub:"View all past rotations",    color:"#8b5cf6", action:()=>setView("rotLog")    },
            { icon:"levelUp",  label:"Level Requests",   sub:`${pending.length} pending`,  color:"#d97706", action:()=>setView("requests"), badge:pending.length },
          ].map(item=>(
            <Card key={item.label} onClick={item.action} style={{ display:"flex", alignItems:"center", gap:14 }}>
              <div style={{ width:40, height:40, borderRadius:10, backgroundColor:item.color+"15", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}><Icon name={item.icon} size={19} color={item.color}/></div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:14, fontWeight:600, color:"#1e293b" }}>{item.label}</div>
                <div style={{ fontSize:12, color:"#94a3b8", marginTop:1 }}>{item.sub}</div>
              </div>
              {item.badge>0 && <span style={{ backgroundColor:"#dc2626", color:"#fff", borderRadius:10, padding:"2px 8px", fontSize:12, fontWeight:700 }}>{item.badge}</span>}
              <Icon name="chevR" size={16} color="#cbd5e1"/>
            </Card>
          ))}
        </div>
      </div>

      {/* Data */}
      <div style={{ marginBottom:20 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
          <span style={{ fontSize:12, fontWeight:700, color:"#94a3b8", textTransform:"uppercase", letterSpacing:"0.08em" }}>Data</span>
          <span style={{ fontSize:11, color: lastBackup ? "#16a34a" : "#94a3b8", fontWeight:600 }}>
            Last backed up: {fmtBackup(lastBackup)}
          </span>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          <Card onClick={doExport} style={{ display:"flex", alignItems:"center", gap:14 }}>
            <div style={{ width:40, height:40, borderRadius:10, backgroundColor:"#16a34a15", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}><Icon name="download" size={19} color="#16a34a"/></div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:14, fontWeight:600, color:"#1e293b" }}>Export Backup</div>
              <div style={{ fontSize:12, color:"#94a3b8", marginTop:1 }}>Download all data as JSON</div>
            </div>
            <Icon name="chevR" size={16} color="#cbd5e1"/>
          </Card>
          <Card onClick={()=>setView("import")} style={{ display:"flex", alignItems:"center", gap:14 }}>
            <div style={{ width:40, height:40, borderRadius:10, backgroundColor:"#0891b215", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}><Icon name="upload" size={19} color="#0891b2"/></div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:14, fontWeight:600, color:"#1e293b" }}>Import Backup</div>
              <div style={{ fontSize:12, color:"#94a3b8", marginTop:1 }}>Restore from a JSON file</div>
            </div>
            <Icon name="chevR" size={16} color="#cbd5e1"/>
          </Card>
          <Card onClick={()=>setClearConfirm(true)} style={{ display:"flex", alignItems:"center", gap:14 }}>
            <div style={{ width:40, height:40, borderRadius:10, backgroundColor:"#dc262615", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}><Icon name="xmark" size={19} color="#dc2626"/></div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:14, fontWeight:600, color:"#dc2626" }}>Clear All Data</div>
              <div style={{ fontSize:12, color:"#94a3b8", marginTop:1 }}>Factory reset — cannot be undone</div>
            </div>
            <Icon name="chevR" size={16} color="#cbd5e1"/>
          </Card>
        </div>
      </div>

      <p style={{ fontSize:11, color:"#cbd5e1", textAlign:"center" }}>69 Chest Tracker · Day 7 Build · Phase 1 of 5</p>

      {clearConfirm && (
        <Modal
          title="Clear all data?"
          message="This will permanently delete all players, scores, level requests, and rotation history. Export a backup first if you want to keep your data."
          confirmLabel="Yes, clear everything"
          confirmVariant="danger"
          onConfirm={doReset}
          onCancel={()=>setClearConfirm(false)}
        />
      )}
    </div>
  );
};

// ─── BOTTOM NAV ───────────────────────────────────────────────────────────────
const NAV_ITEMS = [
  { id:"players",     label:"Players",      icon:"players"  },
  { id:"scores",      label:"Score Entry",  icon:"score"    },
  { id:"trends",      label:"Summary",      icon:"trends"   },
  { id:"updateLevel", label:"Update Level", icon:"levelUp"  },
  { id:"admin",       label:"Admin",        icon:"admin"    },
];

const BottomNav = ({ active, onChange, badge }) => (
  <div style={{ position:"fixed", bottom:0, left:0, right:0, backgroundColor:"#fff", borderTop:"1px solid #e2e8f0", display:"flex", paddingBottom:"env(safe-area-inset-bottom,0px)", zIndex:100 }}>
    {NAV_ITEMS.map(item=>(
      <button key={item.id} onClick={()=>onChange(item.id)} style={{ flex:1, padding:"10px 2px 12px", display:"flex", flexDirection:"column", alignItems:"center", gap:3, border:"none", backgroundColor:"transparent", cursor:"pointer", position:"relative" }}>
        <div style={{ transform:active===item.id?"scale(1.1)":"scale(1)", transition:"transform 0.15s", position:"relative" }}>
          <Icon name={item.icon} size={21} color={active===item.id?"#1e293b":"#94a3b8"}/>
          {item.id==="admin"&&badge>0 && <span style={{ position:"absolute", top:-4, right:-6, backgroundColor:"#dc2626", color:"#fff", borderRadius:8, fontSize:9, fontWeight:800, padding:"1px 4px", lineHeight:"14px", minWidth:14, textAlign:"center" }}>{badge}</span>}
        </div>
        <span style={{ fontSize:9, fontWeight:active===item.id?700:500, color:active===item.id?"#1e293b":"#94a3b8", whiteSpace:"nowrap" }}>{item.label}</span>
        {active===item.id && <div style={{ position:"absolute", bottom:0, width:28, height:2.5, backgroundColor:"#1e293b", borderRadius:"2px 2px 0 0" }}/>}
      </button>
    ))}
  </div>
);

// ─── PAGE HEADER ──────────────────────────────────────────────────────────────
const PageHeader = ({ screen }) => {
  const titles = {
    players:     { title:"Players",      sub:"Clan rosters & levels"  },
    scores:      { title:"Score Entry",  sub:"Record event scores"    },
    trends:      { title:"Summary",      sub:"Trends & performance"   },
    updateLevel: { title:"Update Level", sub:"Submit a level request" },
    admin:       { title:"Admin",        sub:"Settings & tools"       },
  };
  const { title, sub } = titles[screen]||titles.admin;
  return (
    <div style={{ padding:"20px 16px 14px", backgroundColor:"#fff", borderBottom:"1px solid #f1f5f9", position:"sticky", top:0, zIndex:50 }}>
      <div style={{ display:"flex", alignItems:"flex-end", justifyContent:"space-between" }}>
        <div>
          <div style={{ fontSize:10, fontWeight:700, color:"#94a3b8", textTransform:"uppercase", letterSpacing:"0.1em", fontFamily:"'DM Mono',monospace", marginBottom:2 }}>69 Chest Tracker</div>
          <h1 style={{ fontSize:24, fontWeight:800, color:"#1e293b", margin:0, letterSpacing:"-0.02em" }}>{title}</h1>
          <p style={{ fontSize:13, color:"#94a3b8", margin:"2px 0 0", fontWeight:500 }}>{sub}</p>
        </div>
        <div style={{ width:38, height:38, borderRadius:10, backgroundColor:"#1e293b", display:"flex", alignItems:"center", justifyContent:"center" }}>
          <Icon name="trophy" size={18} color="#f59e0b"/>
        </div>
      </div>
    </div>
  );
};

// ─── APP ROOT ─────────────────────────────────────────────────────────────────
export default function App() {
  const [screen,setScreen] = useState("players");
  const { total } = getActionItems();
  const screens = {
    players:     <PlayersScreen/>,
    scores:      <ScoreEntryScreen/>,
    trends:      <TrendsScreen/>,
    updateLevel: <UpdateLevelScreen/>,
    admin:       <AdminScreen/>,
  };
  return (
    <div style={{ maxWidth:430, margin:"0 auto", minHeight:"100vh", backgroundColor:"#f8fafc", fontFamily:"'Outfit','DM Sans',system-ui,sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=DM+Mono:wght@400;500;600&display=swap');
        *{box-sizing:border-box;}
        input:focus,textarea:focus,select:focus{border-color:#1e293b!important;box-shadow:0 0 0 3px rgba(30,41,59,0.08);}
        input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;}
        ::-webkit-scrollbar{display:none;}
        button{min-height:44px;}
        button:active{opacity:0.82;}
        html{scroll-behavior:smooth;-webkit-text-size-adjust:100%;}
        a,button{-webkit-tap-highlight-color:transparent;}
      `}</style>
      <PageHeader screen={screen}/>
      <div style={{ paddingBottom:80 }}>{screens[screen]}</div>
      <BottomNav active={screen} onChange={setScreen} badge={total}/>
    </div>
  );
}
