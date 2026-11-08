// Wicked Player - Main Application
// Auto-updateable, ad-free music player with overlays, search, lyrics and community
// Enhanced with: Equalizer, Pitch control, Full reset

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Soundboard from './soundboard.jsx';
import Community from './community.jsx';
import { getSocket, getMe, setMe as persis } from './socket.js';

const API = 'http://localhost:5000';

// ============ AUDIO ENHANCEMENT STATE ============
// Equalizer bands (frequency bands for vocal/beat control)
const EQ_BANDS = [
  { id: 'sub', min: 20, max: 150, default: 0, label: 'Sub Bass' },
  { id: 'bass', min: 60, max: 300, default: 0, label: 'Bass' },
  { id: 'low-mid', min: 150, max: 800, default: 0, label: 'Low Mid' },
  { id: 'mid', min: 400, max: 3000, default: 0, label: 'Mid' },
  { id: 'high-mid', min: 1500, max: 6000, default: 0, label: 'High Mid' },
  { id: 'presence', min: 3000, max: 8000, default: 0, label: 'Presence' },
  { id: 'brilliance', min: 6000, max: 20000, default: 0, label: 'Brilliance' },
];

// Pitch/tone control state
const PITCH_STATE = {
  semitones: 0, // -12 to +12 semitones
  detuneCents: 0, // -50 to +50 cents
};

// ============ APP COMPONENT ============
function App() {
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(null);
  const audioRef = useRef(null);
  const fxRef = useRef(null); // Audio effects context
  const meRef = useRef(null);

  // Auto-login from localStorage
  useEffect(() => {
    const stored = localStorage.getItem('wp-token-' + 'user');
    if (stored) {
      // Session already active, don't show sign-in form
    }
  }, []);

  // Equalizer state
  const [eq, setEq] = useState(() => {
    // Initialize with default values (all bands at 0 = flat)
    const initial = {};
    EQ_BANDS.forEach(band => {
      initial[band.id] = band.default;
    });
    return initial;
  });

  // Pitch state
  const [pitch, setPitch] = useState({ semitones: 0, detuneCents: 0 });

  // Search functionality
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);

  // Apply EQ to audio context
  const applyEq = useCallback((ctx, fx) => {
    if (!fx?.ready) return;
    fx.eqNodes.forEach((n, i) => {
      const val = eq[EQ_BANDS[i].id] || 0;
      n.gain.value = val; // Boost/cut each band
    });
  }, [eq]);

  // Apply pitch/tone change preserving speed
  const applyPitch = useCallback((ctx, fx, track) => {
    if (!fx?.ready) return;
    // Set pitch shift without affecting playback rate
    const pitchSemitones = pitch.semitones;
    const pitchRatio = Math.pow(2, pitchSemitones / 12);
    
    // Apply pitch shift using frequency shift
    if (fx.pitchShiftL?.parameters?.get) {
      fx.pitchShiftL.parameters.get('ratio').value = pitchRatio;
      fx.pitchShiftR.parameters.get('ratio').value = pitchRatio;
    }
    if (fx.pitchShiftL) {
      fx.pitchShiftL.ratio = pitchRatio;
      fx.pitchShiftR.ratio = pitchRatio;
    }
  }, [pitch]);

  // Handle search
  const handleSearch = async (query) => {
    setIsSearching(true);
    try {
      const res = await fetch(API + '/search?q=' + query);
      const data = await res.json();
      setSearchResults(data?.results || []);
    } catch (e) {
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  // Start track with all enhancements
  const startSrc = useCallback(async (track, position = null) => {
    const a = audioRef.current;
    if (!a) return;

    setCurrent(track);
    setProgress(0);
    setTime(0);

    try {
      // Apply pitch adjustment before playing
      if (fxRef.current) {
        applyPitch(null, fxRef.current, track);
        applyEq(null, fxRef.current);
      }

      const url = '/audio?u=' + (track.url || '');
      a.src = url;
      a.playbackRate = 1; // Always speed = 1, pitch handled separately
      await a.play();
      setPlaying(true);

      // Fetch lyrics
      if (track.artist && track.name) {
        fetch(API + '/lyrics?artist=' + encodeURIComponent(track.artist.split(',')[0]) + '&track=' + encodeURIComponent(track.name.replace(/\(.*\)/, '').trim()))
          .then((x) => x.json())
          .then((l) => setLyrics({ synced: null, plain: l.plain }))
          .catch(() => {});
      }
    } catch (err) {
      setPlaying(false);
      setError('Could not play this track');
    }
  }, [eq, pitch]);

  // Reset ALL audio enhancements to defaults
  const resetAudio = useCallback(() => {
    // Reset all EQ bands to 0 (flat)
    setEq(EQ_BANDS.reduce((acc, band) => {
      acc[band.id] = band.default;
      return acc;
    }, {}));
    
    // Reset pitch to neutral
    setPitch({ semitones: 0, detuneCents: 0 });
  }, []);

  useEffect(() => {
    // Set up socket connection
    const socket = getSocket();
    socket.connect();

    return () => {
      socket.disconnect();
    };
  }, []);

  // UI Render
  return React.createElement('div', { className: 'wicked-player' },
    React.createElement('h1', null, 'Wicked Player'),
    
    // Audio Enhancement Controls
    React.createElement('div', { className: 'audio-enhancement' },
      React.createElement('h3', null, 'Audio Enhancement'),
      
      // Equalizer section
      React.createElement('div', { className: 'equalizer-section' },
        React.createElement('p', null, 'Equalizer:'),
        React.createElement('div', { className: 'eq-bands' },
          EQ_BANDS.map((band) =>
            React.createElement('div', { key: band.id, className: 'eq-band' },
              React.createElement('span', { className: 'band-label' }, band.label),
              React.createElement('input', {
                type: 'range',
                min: band.min,
                max: band.max,
                value: eq[band.id] || band.default,
                onChange: (e) => {
                  const newEq = { ...eq };
                  newEq[band.id] = parseFloat(e.target.value);
                  setEq(newEq);
                },
                className: 'eq-slider'
              }),
              React.createElement('span', { className: 'band-value' }, (eq[band.id] || 0).toFixed(1))
            )
          )
        )
      ),
      
      // Full Reset Button - resets ALL features
      React.createElement('button', {
        className: 'reset-button',
        onClick: resetAudio
      }, 'Reset All Enhancements'),
      
      // Pitch/Tone Control - changes pitch/tone but keeps speed the same
      React.createElement('div', { className: 'pitch-section' },
        React.createElement('p', null, 'Pitch/Tone:'),
        React.createElement('div', { className: 'pitch-controls' },
          React.createElement('span', { className: 'pitch-label' }, 'Semitones:'),
          React.createElement('span', { className: 'pitch-value' }, 
            pitch.semitones === 0 ? 'neutral' : 
            pitch.semitones > 0 ? '+' + pitch.semitones : pitch.semitones
          ),
          React.createElement('button', {
            className: 'pitch-btn',
            onClick: () => setPitch(p => ({ ...p, semitones: p.semitones - 1 }))
          }, '−'),
          React.createElement('button', {
            className: 'pitch-btn',
            onClick: () => setPitch(p => ({ ...p, semitones: p.semitones + 1 }))
          }, '+')
        )
      )
    )
  );
}

// ============ EXPORT ============
export default App;
