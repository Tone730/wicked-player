import { useState, useEffect, useRef, useCallback } from 'react';
import { getSocket } from './socket.js';

const API = 'http://localhost:5000';
const GENRES = ['Pop', 'Rock', 'Hip-Hop/Rap', 'R&B/Soul', 'Electronic', 'Dance', 'Jazz', 'Country'];
const SOCIALS = [
  ['discord', '💬', 'Discord'],
  ['tiktok', '🎵', 'TikTok'],
  ['instagram', '📸', 'Instagram'],
  ['twitter', '𝕏', 'X / Twitter'],
  ['youtube', '▶️', 'YouTube'],
  ['spotify', '🎧', 'Spotify'],
  ['twitch', '🟣', 'Twitch'],
  ['soundcloud', '☁️', 'SoundCloud'],
  ['website', '🌐', 'Website'],
];
function linkUrl(k, v) {
  if (/^https?:\/\//i.test(v)) return v;
  switch (k) {
    case 'discord': return v.startsWith('discord.gg') ? `https://${v}` : `https://discord.com/users/${v}`;
    case 'tiktok': return `https://www.tiktok.com/@${v.replace(/^@/, '')}`;
    case 'instagram': return `https://instagram.com/${v}`;
    case 'twitter': return `https://x.com/${v}`;
    case 'youtube': return `https://youtube.com/@${v.replace(/^@/, '')}`;
    case 'spotify': return `https://open.spotify.com/user/${v}`;
    case 'twitch': return `https://twitch.tv/${v}`;
    case 'soundcloud': return `https://soundcloud.com/${v}`;
    default: return v;
  }
}
function LinkChips({ links = {} }) {
  const items = SOCIALS.filter(([k]) => links[k]);
  if (!items.length) return null;
  return (
    <span className="link-chips">
      {items.map(([k, ico, label]) => (
        <a key={k} className="link-chip" href={linkUrl(k, links[k])} target="_blank" rel="noreferrer" title={label}
           onClick={(e) => e.stopPropagation()}>{ico}</a>
      ))}
    </span>
  );
}

function PlCollage({ tracks, size = 52 }) {
  const arts = (tracks || []).map((t) => t.art).filter(Boolean).slice(0, 4);
  if (!arts.length) return <div className="pl-collage ph" style={{ width: size, height: size }}>&#9834;</div>;
  return (
    <div className="pl-collage" style={{ width: size, height: size }}>
      {(arts.length < 4 ? [arts[0], arts[0], arts[0], arts[0]] : arts).slice(0, 4).map((a, i) => (
        <img key={i} src={a} alt="" />
      ))}
    </div>
  );
}
export default function Community({ me, setMe, current, onPlay, onSyncPlay, onSyncPause, premium, setPremium }) {
  const sock = getSocket();
  const [nameInput, setNameInput] = useState('');
  const [passInput, setPassInput] = useState('');
  const [people, setPeople] = useState([]);
  const [known, setKnown] = useState({});      // saved profiles
  const [tab, setTab] = useState('people');    // people | friends | chat | listen
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState([]);
  const [thread, setThread] = useState('general');
  const [msgs, setMsgs] = useState({});
  const [text, setText] = useState('');
  const [rooms, setRooms] = useState([]);
  const [listing, setListing] = useState([]);   // listen room snapshots for UI
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState({ bio: '', accent: '#8b5cf6', avatar: me?.avatar || '', banner: me?.banner || '', displayName: me?.displayName || '', status: me?.status || '', favGenre: me?.favGenre || '', links: me?.links || {}, bannerStyle: me?.bannerStyle || '', bannerFrom: me?.bannerFrom || '#8b5cf6', bannerTo: me?.bannerTo || '#1d1f21', bannerAnimated: !!me?.bannerAnimated, tagText: me?.tagText || '', tagColor: me?.tagColor || '#a855f7', tagGlow: !!me?.tagGlow, tagAnim: me?.tagAnim || '' });
  const [webhook, setWebhook] = useState('');
  const [toast, setToast] = useState('');
  const [chatRooms, setChatRooms] = useState(['general']);   // group rooms (#name)
  const [groupInfo, setGroupInfo] = useState(null);          // {name, owner, invite}
  const [joinCode, setJoinCode] = useState('');
  const [banned, setBanned] = useState(null);
  const [pubPls, setPubPls] = useState([]);
  const chatEndRef = useRef(null);
  const avFileRef = useRef(null);
  const bnFileRef = useRef(null);

  /* connect + listeners */
  useEffect(() => {
    if (!me) return;
    sock.emit('hello', me);
    const onCommunity = (list) => setPeople(list.filter((p) => p.name !== me.name));
    const onKnown = async () => {
      try {
        const r = await fetch(`${API}/api/profiles`);
        const j = await r.json();
        setKnown(j);
        const mine = j[me.name];
        if (mine) {
          setFriends(mine.friends || []);
          setRequests(mine.incoming || []);
        }
      } catch {}
    };
    const onRooms = (r) => setChatRooms(r.chat || ['general']);
    const onChatNew = ({ conv, msg }) => setMsgs((m) => ({ ...m, [conv]: [...(m[conv] || []), msg] }));
    const onFriendIncoming = ({ from }) => setToast(`💙 ${from} added you as a friend!`);

    sock.emit('profile:update', {});
    onKnown();
    sock.on('community', onCommunity);
    sock.on('rooms', onRooms);
    sock.on('chat:new', onChatNew);
    sock.on('friend:incoming', onFriendIncoming);
    const onBanned = ({ reason }) => setBanned(reason || 'You were banned from the app');
    sock.on('banned', onBanned);
    fetch(`${API}/library/playlists/public`).then((r) => r.json()).then((j) => setPubPls(Array.isArray(j) ? j : [])).catch(() => {});
    const iv = setInterval(onKnown, 5000);
    return () => {
      sock.off('community', onCommunity);
      sock.off('rooms', onRooms);
      sock.off('chat:new', onChatNew);
      sock.off('friend:incoming', onFriendIncoming);
      sock.off('banned', onBanned);
      clearInterval(iv);
      clearInterval(pl);
    };
  }, [me?.name]);

  /* AUTO-LOGIN: restore session silently - no sign-in form ever again */
  useEffect(() => {
    if (me) return;
    const lastName = localStorage.getItem('wp-last-name');
    if (!lastName) return;
    const tok = localStorage.getItem('wp-token-' + lastName);
    if (!tok) return;
    (async () => {
      try {
        const r = await fetch(`${API}/api/profiles`);
        const j = await r.json();
        const saved = j[lastName];
        if (!saved) { localStorage.removeItem('wp-last-name'); return; }
        setMe({ name: lastName, bio: saved.bio || '', accent: saved.accent || '#8b5cf6', avatar: saved.avatar || '', banner: saved.banner || '', displayName: saved.displayName || '', status: saved.status || '', favGenre: saved.favGenre || '', links: saved.links || {}, premium: !!saved.premium });
        setToast(`Welcome back, ${saved.displayName || lastName}`);
      } catch {}
    })();
  }, [me]);
  /* nowplaying broadcast */
  useEffect(() => {
    if (!me) return;
    sock.emit('np', { track: current ? { id: current.id, name: current.name, artist: current.artist, art: current.art, stream_url: current.stream_url, duration_ms: current.duration_ms } : null });
  }, [current?.id, me?.name]);

  /* load thread history when switching */
  useEffect(() => {
    if (!me) return;
    sock.emit('chat:get', { conv: thread }, ({ messages }) => {
      if (messages) setMsgs((m) => ({ ...m, [thread]: messages }));
    });
  }, [thread, me?.name]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs[thread]?.length]);

  /* group room meta (owner + invite code) when inside a group thread */
  useEffect(() => {
    if (!thread.startsWith('#')) { setGroupInfo(null); return; }
    sock.emit('room:info', { room: thread }, (info) => setGroupInfo(info || null));
  }, [thread]);

  /* connect flow */
  async function connect(e) {
    e.preventDefault();
    const name = nameInput.trim();
    if (!name) return;
    const pass = passInput.trim();
    if (!pass) { setToast('Pick a password - it protects your profile and saves your stuff'); return; }
    try {
      const r = await fetch(`${API}/api/auth`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, password: pass }),
      });
      const j = await r.json();
      if (!j.ok) { setToast(j.error || 'Sign-in failed'); return; }
      localStorage.setItem('wp-token-' + name, j.token);
      localStorage.setItem('wp-last-name', name);
      const known = await fetch(`${API}/api/profiles`).then((x) => x.json());
      const saved = known[name] || {};
      const p = { name, bio: saved.bio || '', accent: saved.accent || '#8b5cf6', avatar: saved.avatar || '', banner: saved.banner || '', displayName: saved.displayName || '', status: saved.status || '', favGenre: saved.favGenre || '', links: saved.links || {}, premium: !!saved.premium };
      setForm({ bio: p.bio, accent: p.accent, avatar: p.avatar, banner: p.banner, displayName: p.displayName, status: p.status, favGenre: p.favGenre, links: p.links });
      setMe(p);
      setToast(`Welcome ${name} - your profile auto-saves now`);
    } catch { setToast('Could not reach the server'); }
  }

  function sendMsg(e) {
    e.preventDefault();
    if (!text.trim()) return;
    sock.emit('chat', thread === 'general' || thread.startsWith('#') ? { room: thread, text } : { to: thread, text });
    setText('');
  }

  function startDM(name) {
    setThread(name);
    setTab('chat');
  }

  async function saveProfile(patch) {
    const next = { ...me, ...patch };
    setMe(next);
    await fetch(`${API}/api/profile`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-WP-AUTH": localStorage.getItem("wp-token-" + me.name) || "" },
      body: JSON.stringify({ name: me.name, ...patch }), /* premium is admin-only now */
    });
    sock.emit('profile:update', patch);
    setEditOpen(false);
  }

  async function uploadMedia(kind, e) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) { setToast('File max is 10MB'); return; }
    const fr = new FileReader();
    fr.onload = async () => {
      try {
        const r = await fetch(`${API}/upload`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: f.name, data: fr.result }),
        });
        const j = await r.json();
        setForm((x) => ({ ...x, [kind === 'av' ? 'avatar' : 'banner']: j.url }));
        setToast('Uploaded ✓');
      } catch { setToast('Upload failed'); }
    };
    fr.readAsDataURL(f);
    e.target.value = '';
  }

  async function shareDiscord() {
    try {
      await fetch(`${API}/discord/say`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: me.name, track: current }),
      });
      setToast('Shared to Discord ✓');
    } catch { setToast('Discord share failed (set a webhook first)'); }
  }

  /* ---- group chat rooms + invites ---- */
  function createGroup() {
    const n = (prompt('Group chat name (e.g. gaming crew):') || '').trim().replace(/^#+/, '');
    if (!n) return;
    sock.emit('room:create', { name: n }, (res) => {
      if (res?.room) {
        setThread(res.room);
        setTab('chat');
        setToast(`Group created — invite code: ${res.invite}`);
      }
    });
  }
  function joinGroupByCode() {
    const code = (joinCode || '').toUpperCase().trim();
    if (!code) return;
    sock.emit('room:join', { code }, (res) => {
      if (res?.room) {
        setThread(res.room);
        setTab('chat');
        setJoinCode('');
        setToast(`Joined #${res.name}`);
      } else setToast(res?.error || 'Invalid code');
    });
  }
  function copyInvite(code) {
    try { navigator.clipboard.writeText(code); setToast('Invite code copied — send it to friends!'); }
    catch { setToast(`Invite code: ${code}`); }
  }

  function createRoom() {
    const r = (prompt('Room name (e.g. late night vibes):') || '').trim();
    if (!r) return;
    sock.emit('listen:create', { room: r }, () => {});
    setTab('listen');
  }

  function roomListenClick(room) {
    sock.emit('listen:join', { room });
  }
  function hostPlay() {
    sock.emit('listen:set', { room: me.listenRoom, track: current, playing: true, position: 0 });
  }
  function hostPause() {
    sock.emit('listen:set', { room: me.listenRoom, playing: false });
  }
  function syncFromRoom(room) {
    sock.emit('listen:state', room, (st) => {
      if (st?.track) onSyncPlay({ ...st.track, stream_url: st.track.stream_url }, st.playing ? st.position || 0 : 0, st.playing);
    });
  }
  function joinHost(room) {
    setMe({ ...me, listenRoom: room });
    setToast(`Hosting room "${room}" — play a song!`);
  }

  /* ---------- render ---------- */
  if (!me) {
    return (
      <div className="community">
        <header className="hero">
          <h1>Join the <em>community</em></h1>
          <p className="sub">Pick a name + password - your profile, playlists and everything auto-save to it. Same name + password = your stuff back on any PC.</p>
          <form className="searchbar" onSubmit={connect} style={{ maxWidth: 480, flexWrap: "wrap" }}>
            <span>&#128100;</span>
            <input value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="Your name" autoFocus />
            <input value={passInput} onChange={(e) => setPassInput(e.target.value)} type="password" placeholder="Password" style={{ maxWidth: 160 }} />
            <button type="submit">Join / Sign in</button>
          </form>
        </header>
      </div>
    );
  }

  const convLabel = thread === 'general' ? '🌍 public' : thread.replace(/^#/, '');

  return (
    <div className="community">
      {/* my banner header */}
      <div className="me-card" style={{ '--accent': me.accent || '#8b5cf6' }}>
        <div className={'me-banner' + (me.bannerAnimated ? ' anim' : '')} style={
          me.banner
            ? { backgroundImage: `url(${me.banner.startsWith('http') ? me.banner : API + me.banner})` }
            : (me.bannerStyle === 'gradient' || me.bannerStyle === 'animated')
              ? { background: `linear-gradient(120deg, ${me.bannerFrom || '#8b5cf6'}, ${me.bannerTo || '#1d1f21'})` }
              : {}
        }>
          {me.premium && <span className="pro-badge">✦ PRO</span>}
        </div>
        <div className="me-row">
          {me.avatar
            ? <img className="me-ava" src={me.avatar.startsWith('http') ? me.avatar : API + me.avatar} alt="" />
            : <div className="me-ava letter">{me.name[0]?.toUpperCase()}</div>}
          <div className="me-info">
            <b>{me.displayName || me.name}{me.tagText ? <span className="prof-tag" style={{ '--tag': me.tagColor || '#a855f7', ...(me.tagGlow ? { boxShadow: '0 0 10px ' + (me.tagColor || '#a855f7') } : {}) }}>{me.tagText}</span> : null}{me.status ? <span className="me-status"> · {me.status}</span> : null}</b>
            <small>{me.bio || 'No bio yet'}{me.favGenre ? ` · ♪ ${me.favGenre}` : ''}</small>
            <LinkChips links={me.links || {}} />
          </div>
          <div className="me-actions">
            <button className="pill" onClick={() => setEditOpen(true)}>Edit profile</button>
            <button className="pill" onClick={shareDiscord}>Share to Discord</button>
          </div>
        </div>
      </div>

      {/* inner tabs */}
      <div className="c-tabs">
        {[['people', '👥 People'], ['friends', '💙 Friends'], ['chat', '💬 Chat'], ['playlists', '📻 Playlists'], ['listen', '🎧 Listen Together']].map(([k, label]) => (
          <button key={k} className={`c-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
        <button className="pill c-newroom" onClick={createRoom}>＋ New room</button>
      </div>

      {/* requests toast */}
      {banned !== null && (
        <div className="modal-wrap">
          <div className="modal">
            <h3>&#9940; Access revoked</h3>
            <p className="sub">This account has been banned from Wicked Player.</p>
            <p className="sub">Reason: {banned}</p>
            <p className="sub">If you believe this is a mistake, contact the host on Discord.</p>
          </div>
        </div>
      )}
      {toast && <div className="toast" onClick={() => setToast('')}>{toast}</div>}

      {/* ---- PEOPLE ---- */}
      {tab === 'people' && (
        <section className="c-body">
          {requests?.length > 0 && (
            <div className="req-strip">
              Friend requests:&nbsp;
              {requests.filter((r) => r !== me.name).map((r) => (
                <span key={r} className="req">
                  {r}
                  <button onClick={() => sock.emit('friend:accept', { name: r })}>✓</button>
                  <button onClick={() => sock.emit('friend:decline', { name: r })}>✕</button>
                </span>
              ))}
            </div>
          )}
          <div className="people-grid">
            {people.length === 0 && <div className="empty">Nobody else online yet. Open another tab, pick another name, and say hi 👋</div>}
            {people.map((p) => (
              <div className="person" key={p.sid} style={{ '--pc': p.accent }}>
                <div className="p-banner" style={p.banner ? { backgroundImage: `url(${p.banner.startsWith('http') ? p.banner : API + p.banner})` } : {}} />
                <div className="p-row">
                  {p.avatar
                    ? <img className="p-ava" src={p.avatar.startsWith('http') ? p.avatar : API + p.avatar} alt="" />
                    : <div className="p-ava letter">{p.name[0]?.toUpperCase()}</div>}
                  <div className="p-info">
                    <b>{(known[p.name]?.displayName) || p.name}{p.premium && <span className="pro-badge sm">✦</span>}</b>
                    <small>{p.nowplaying ? `♪ ${p.nowplaying.name}` : ((known[p.name]?.status) || p.bio || 'hanging out')}</small>
                    <LinkChips links={known[p.name]?.links || {}} />
                  </div>
                </div>
                {p.nowplaying && (
                  <button className="pill join-song" onClick={() => onPlay({ ...p.nowplaying })}>
                    ▶ Play along
                  </button>
                )}
                <div className="p-actions">
                  <button className="pill" onClick={() => startDM(p.name)}>Message</button>
                  <button className="pill" onClick={() => sock.emit('friend:ask', { name: p.name })}>＋ Friend</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---- FRIENDS ---- */}
      {tab === 'friends' && (
        <section className="c-body">
          <div className="people-grid">
            {friends.length === 0 && <div className="empty">No friends yet — add people from the People tab.</div>}
            {friends.map((f) => {
              const p = known[f] || {};
              const online = people.some((x) => x.name === f);
              return (
                <div className={`person ${online ? '' : 'offline'}`} key={f} style={{ '--pc': p.accent || me.accent }}>
                  <div className="p-banner" style={p.banner ? { backgroundImage: `url(${p.banner.startsWith('http') ? p.banner : API + p.banner})` } : {}} />
                  <div className="p-row">
                    {p.avatar
                      ? <img className="p-ava" src={p.avatar.startsWith('http') ? p.avatar : API + p.avatar} alt="" />
                      : <div className="p-ava letter">{f[0]?.toUpperCase()}</div>}
                    <div className="p-info">
                      <b>{p.displayName || f}{p.premium && <span className="pro-badge sm">✦</span>}</b>
                      <small>{online ? '🟢 online' : '⚪ offline'}{p.status ? ` · ${p.status}` : p.bio ? ` · ${p.bio}` : ''}</small>
                      <LinkChips links={p.links || {}} />
                    </div>
                  </div>
                  <div className="p-actions">
                    <button className="pill" onClick={() => startDM(f)}>Message</button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ---- CHAT ---- */}
      {tab === 'chat' && (
        <section className="c-body chat-body">
          <div className="thread-bar">
            <button className={`pill ${thread === 'general' ? 'on' : ''}`} onClick={() => setThread('general')}>🌍 Public</button>
            {chatRooms.filter((r) => r !== 'general').map((r) => (
              <button key={r} className={`pill ${thread === r ? 'on' : ''}`} onClick={() => setThread(r)}>{r.replace(/^#/, '')}</button>
            ))}
            {friends.map((f) => <button key={f} className={`pill dm ${thread === f ? 'on' : ''}`} onClick={() => setThread(f)}>✉ {f}</button>)}
            <button className="pill accent" onClick={createGroup} title="Create a group chat with an invite code">＋ New group</button>
          </div>
          <div className="join-strip">
            <input value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="Paste invite code…" maxLength={8} />
            <button type="button" className="pill" onClick={joinGroupByCode}>Join group</button>
            {thread.startsWith('#') && groupInfo?.invite && (
              <span className="invite-chip">
                🔗 Invite: <b>{groupInfo.invite}</b>
                <button type="button" className="pill" onClick={() => copyInvite(groupInfo.invite)}>Copy</button>
                <small>owner: {groupInfo.owner}</small>
              </span>
            )}
            {thread === 'general' && <small className="mini-note">Everyone is here — say hi 👋</small>}
          </div>
          <div className="chat-win">
            {(msgs[thread] || []).map((m, i) => (
              <div className={`bub ${m.from === me.name ? 'mine' : ''}`} key={i}>
                {m.from !== me.name && (m.avatar
                  ? <img className="b-ava" src={m.avatar.startsWith('http') ? m.avatar : API + m.avatar} alt="" />
                  : <div className="b-ava letter" style={{ background: m.accent }}>{m.from[0]}</div>)}
                <div className="b-body">
                  <small>{m.from === me.name ? 'you' : m.from}</small>
                  <p>{m.text}</p>
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <form className="chat-input" onSubmit={sendMsg}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message ${convLabel}…`} />
            <button type="submit">Send</button>
          </form>
        </section>
      )}

      {/* ---- PUBLIC PLAYLISTS ---- */}
      {tab === 'playlists' && (
        <section className="c-body">
          <p className="sub">Playlists people made public. Click one to load the tracks in the player.</p>
          <div className="people-grid">
            {!pubPls.length && <div className="empty">No public playlists yet - open one of your playlists in Playlists and flip it to &#127760; Public.</div>}
            {pubPls.map((pl) => (
              <div className="person" key={pl.user + pl.name} style={{ '--pc': '#a855f7' }}>
                <div className="p-row">
                  <PlCollage tracks={pl.tracks} size={52} />
                  <div className="p-info">
                    <b>{pl.name}</b>
                    <small>{pl.total} tracks · by {pl.user}</small>
                  </div>
                </div>
                <div className="p-actions">
                  <button className="pill accent" onClick={() => {
                    if (onPlay && pl.tracks?.length) {
                      pl.tracks.forEach(() => {});
                      onPlay(pl.tracks[0]);
                      setToast(`Playing "${pl.name}" - ${pl.total} tracks queued`);
                    }
                  }}>▶ Play</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {/* ---- LISTEN TOGETHER ---- */}
      {tab === 'listen' && (
        <section className="c-body">
          <div className="listen-grid">
            {rooms.length === 0 && <div className="empty">No rooms yet — make one with ＋ New room.</div>}
            {rooms.map((r) => (
              <div className="room" key={r.name}>
                <div className="r-head">
                  <b>{r.name}</b>
                  <small>host: {r.host} · {r.listeners} listening</small>
                </div>
                {r.track
                  ? <div className="r-track">♪ {r.track.name} — {r.track.artist || ''}</div>
                  : <div className="r-track dim">host hasn't started a song yet</div>}
                <div className="p-actions">
                  {me.listenRoom === r.name ? (
                    <>
                      <span className="pill host-pill">🎤 You host</span>
                      <button className="pill" onClick={hostPlay}>▶ Host play</button>
                      <button className="pill" onClick={hostPause}>⏸</button>
                    </>
                  ) : (
                    <>
                      <button className="pill" onClick={() => roomListenClick(r.name)}>Join room</button>
                      {r.track && <button className="pill" onClick={() => syncFromRoom(r.name)}>▶ Sync now</button>}
                    </>
                  )}
                  {me.listenRoom !== r.name && <button className="pill ghost-pill" onClick={() => joinHost(r.name)}>Set as my room</button>}
                </div>
              </div>
            ))}
          </div>
          <p className="sub">Everyone synced to the second — the host's play/pause/track drives the room. "Set as my room" then use Host play while a song is loaded.</p>
        </section>
      )}

      {/* profile editor */}
      {editOpen && (
        <div className="modal-wrap" onClick={(e) => e.target === e.currentTarget && setEditOpen(false)}>
          <div className="modal">
            <h3>Edit profile</h3>
            <div className="fld two">
              <div><label>Display name</label>
                <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="How should we show you?" /></div>
              <div><label>Status</label>
                <input value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} placeholder="Vibing 🎶 / chilling / working…" /></div>
            </div>
            <div className="fld"><label>Favorite genre</label>
              <select value={form.favGenre} onChange={(e) => setForm({ ...form, favGenre: e.target.value })}>
                <option value="">— pick one —</option>
                {GENRES.map((g) => <option key={g} value={g}>{g}</option>)}
              </select></div>
            <div className="fld"><label>Bio</label>
              <input value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} placeholder="Say something about you…" /></div>
            <div className="fld"><label>Accent color</label>
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(form.accent) ? form.accent : '#8b5cf6'} onChange={(e) => setForm({ ...form, accent: e.target.value })} /></div>
            <div className="fld two">
              <div><label>Avatar</label>
                <div className="up-row">
                  <input value={form.avatar} onChange={(e) => setForm({ ...form, avatar: e.target.value })} placeholder="image/GIF url…" />
                  <button onClick={() => avFileRef.current?.click()}>Upload</button>
                  <input ref={avFileRef} type="file" accept="image/*" hidden onChange={(e) => uploadMedia('av', e)} />
                </div>
                {form.avatar && <img className="prev" src={form.avatar.startsWith('http') ? form.avatar : API + form.avatar} alt="" />}
              </div>
              <div><label>Banner (GIFs ok)</label>
                <div className="up-row">
                  <input value={form.banner} onChange={(e) => setForm({ ...form, banner: e.target.value })} placeholder="banner/GIF url…" />
                  <button onClick={() => bnFileRef.current?.click()}>Upload</button>
                  <input ref={bnFileRef} type="file" accept="image/*" hidden onChange={(e) => uploadMedia('bn', e)} />
                </div>
                {form.banner && <img className="prev wide" src={form.banner.startsWith('http') ? form.banner : API + form.banner} alt="" />}
              </div>
            </div>
            <div className="fld"><label>Profile banner style (custom + animated = Premium &#10022;)</label>
              <div className="social-grid">
                <select value={form.bannerStyle} onChange={(e) => setForm((f) => ({ ...f, bannerStyle: e.target.value }))}>
                  <option value="">Default</option>
                  <option value="gradient">Custom gradient</option>
                  <option value="upload">Uploaded image / GIF</option>
                  <option value="animated" disabled={!premium}>Animated gradient &#10022;</option>
                </select>
                {(form.bannerStyle === 'gradient' || form.bannerStyle === 'animated') ? (
                  <div className="social-row">
                    <input type="color" value={/^#[0-9a-f]{6}$/i.test(form.bannerFrom) ? form.bannerFrom : '#8b5cf6'} onChange={(e) => setForm((f) => ({ ...f, bannerFrom: e.target.value }))} title="From color" />
                    <input type="color" value={/^#[0-9a-f]{6}$/i.test(form.bannerTo) ? form.bannerTo : '#1d1f21'} onChange={(e) => setForm((f) => ({ ...f, bannerTo: e.target.value }))} title="To color" />
                  </div>
                ) : null}
              </div>
              <small className="hint">{!premium && form.bannerStyle === 'animated' ? 'Animated gradients are a Premium &#10022; feature' : 'Custom gradients + animation unlock with Premium &#10022;'}</small>
            </div>
            <div className="fld"><label>Profile tag (custom title plate - Premium &#10022;)</label>
              <div className="social-grid">
                <input value={form.tagText} disabled={!premium} onChange={(e) => setForm((f) => ({ ...f, tagText: e.target.value }))} placeholder={premium ? 'e.g. FOUNDER / DJ / VETERAN' : 'Premium &#10022; feature'} maxLength={24} />
                <div className="social-row">
                  <input type="color" value={/^#[0-9a-f]{6}$/i.test(form.tagColor) ? form.tagColor : '#a855f7'} disabled={!premium} onChange={(e) => setForm((f) => ({ ...f, tagColor: e.target.value }))} title="Tag color" />
                  <label style={{ fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                    <input type="checkbox" checked={form.tagGlow} disabled={!premium} onChange={(e) => setForm((f) => ({ ...f, tagGlow: e.target.checked }))} /> glow
                  </label>
                </div>
              </div>
              {!premium && <small className="hint">Unlock with Premium &#10022; - granted by admin or reward codes</small>}
            </div>
              <div className="fx-presets" style={{ marginTop: 6 }}>
                {[["", "None"], ["shimmer", "Shimmer"], ["rainbow", "Rainbow"], ["pulse", "Pulse"], ["neon", "Neon"], ["gold", "Gold"], ["fire", "Fire"], ["ice", "Ice"], ["toxic", "Toxic"], ["candy", "Candy"]].map(([v, label]) => (
                  <button key={v || "none"} type="button" className={`pill ${(form.tagAnim || "") === v ? "accent" : ""}`} disabled={!premium}
                    onClick={() => setForm((f) => ({ ...f, tagAnim: v }))}>{label}{v ? " \u2726" : ""}</button>
                ))}
              </div>
              {!premium && <small className="hint">Animated tags unlock with Premium &#10022; - granted by admin or reward codes</small>}
            <div className="fld"><label>Link your accounts</label>
              <div className="social-grid">
                {SOCIALS.map(([k, ico, label]) => (
                  <div className="social-row" key={k}>
                    <span className="social-ico" title={label}>{ico}</span>
                    <input value={form.links[k] || ''}
                      onChange={(e) => setForm((f) => ({ ...f, links: { ...f.links, [k]: e.target.value } }))}
                      placeholder={k === 'website' ? 'https://your-site.com' : `${label} username`} />
                  </div>
                ))}
              </div>
              <small className="hint">Usernames or full links both work. Shown as chips on your profile.</small></div>
            <div className="fld"><label>Discord webhook (auto-share what you play)</label>
              <input value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://discord.com/api/webhooks/…" />
              <small className="hint">In Discord: channel settings → Integrations → Webhooks → New → Copy URL</small></div>
            <div className="fld badge-row">
              {premium
                ? <span className="prem-badge on">✦ Wicked Premium — active</span>
                : <span className="prem-badge">✦ Premium is granted by the admin or by redeeming a code in Settings</span>}
            </div>
            <div className="modal-actions">
              <button className="pill" onClick={() => setEditOpen(false)}>Cancel</button>
              <button className="pill accent" onClick={() => saveProfile({
                bio: form.bio, accent: form.accent, avatar: form.avatar, banner: form.banner,
                displayName: form.displayName, status: form.status, favGenre: form.favGenre, links: form.links, bannerStyle: form.bannerStyle, bannerFrom: form.bannerFrom, bannerTo: form.bannerTo, bannerAnimated: form.bannerAnimated, tagText: form.tagText, tagColor: form.tagColor, tagGlow: form.tagGlow, tagAnim: form.tagAnim,
                discordWebhook: webhook,
              })}>Save profile</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
