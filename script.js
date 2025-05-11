let chart;

async function init() {
  // Load game data and initialize chart
  const data = await fetch('data/sample-game.json').then(res => res.json());
  initChart(data.timeline, data.deathPeriods['player1'] || []);
  setupDetailOverlay();
}

document.addEventListener('DOMContentLoaded', init);

function initChart(timeline, deathPeriods) {
  chart = Highcharts.chart('scoreChart', {
    chart: { type: 'line', backgroundColor: '#2a2a2a' },
    title: { text: null },
    xAxis: {
      title: { text: 'Time (s)' },
      labels: { style: { color: '#ccc' } },
      plotBands: deathPeriods.map(p => ({ from: p.start, to: p.end, color: 'rgba(255,0,0,0.2)' }))
    },
    yAxis: { title: { text: 'Score' }, labels: { style: { color: '#ccc' } } },
    series: [{ name: 'Score', data: timeline.map(pt => [pt.time, pt.score]), color: '#ddd' }],
    credits: { enabled: false }
  });
}

// Placeholder player data
const playerData = {
  player1: { name: 'Loose Cannon', tags: 47, tagsGrade: 'A', ratio: '120%', ratioGrade: 'A+', goals: 2, goalsGrade: 'A+', denies: 2, deniesGrade: 'B', active: '76%', activeGrade: 'B' },
  player2: { name: 'Yeezy Woo', tags: 40, tagsGrade: 'B', ratio: '110%', ratioGrade: 'B+', goals: 1, goalsGrade: 'A', denies: 3, deniesGrade: 'A-', active: '80%', activeGrade: 'A-' }
  // Add more players as needed
};

function setupDetailOverlay() {
  const overlay = document.getElementById('detail-overlay');
  const closeBtn = document.getElementById('close-detail');
  const fields = {
    name: document.getElementById('detail-name'),
    tags: document.getElementById('detail-tags'),
    tagsGrade: document.getElementById('detail-tags-grade'),
    ratio: document.getElementById('detail-ratio'),
    ratioGrade: document.getElementById('detail-ratio-grade'),
    goals: document.getElementById('detail-goals'),
    goalsGrade: document.getElementById('detail-goals-grade'),
    denies: document.getElementById('detail-denies'),
    deniesGrade: document.getElementById('detail-denies-grade'),
    active: document.getElementById('detail-active'),
    activeGrade: document.getElementById('detail-active-grade')
  };

  function showDetail(pid) {
    const d = playerData[pid] || {};
    fields.name.textContent = d.name || pid;
    fields.tags.textContent = d.tags || '-';
    fields.tagsGrade.textContent = d.tagsGrade || '-';
    fields.ratio.textContent = d.ratio || '-';
    fields.ratioGrade.textContent = d.ratioGrade || '-';
    fields.goals.textContent = d.goals || '-';
    fields.goalsGrade.textContent = d.goalsGrade || '-';
    fields.denies.textContent = d.denies || '-';
    fields.deniesGrade.textContent = d.deniesGrade || '-';
    fields.active.textContent = d.active || '-';
    fields.activeGrade.textContent = d.activeGrade || '-';
    overlay.classList.remove('hidden');
  }

  // Click handlers for player boxes
  document.querySelectorAll('.player-summary').forEach(el => {
    el.addEventListener('click', () => showDetail(el.dataset.playerId));
  });

  // Close button
  closeBtn.addEventListener('click', () => overlay.classList.add('hidden'));


}

// 1) Load the YouTube IFrame API
const ytTag = document.createElement('script');
ytTag.src = 'https://www.youtube.com/iframe_api';
document.head.appendChild(ytTag);

// 2) YouTube API ready callback (optional flag or setup)
let YTReady = false;
function onYouTubeIframeAPIReady() {
  YTReady = true;
  console.log('YouTube IFrame API is ready');
}

// — Existing code below —

// Draggable Video Modal elements
const modal = document.getElementById('videoModal');
const modalHeader = modal.querySelector('.modal-header');
const modalPlayer = document.getElementById('modalPlayer');
const ytCloseBtn   = document.getElementById('modalClose');

let isDragging = false;
let dragOffset = { x: 0, y: 0 };

// Show & load video into modal on ▶ button click
document.getElementById('loadButton').addEventListener('click', () => {
  const url = document.getElementById('youtubeUrl').value;
  const videoId = parseYouTubeId(url);
  if (!videoId) return;

  // Wait for API to be ready if you need programmatic control later
  modalPlayer.src = `https://www.youtube.com/embed/${videoId}?enablejsapi=1&origin=${location.origin}`;
  modal.style.display = 'block';
});

// Close button hides modal (and stops video)
ytCloseBtn.addEventListener('click', () => {
  modal.style.display = 'none';
  modalPlayer.src = '';  // unload to stop playback
});

// Drag start
modalHeader.addEventListener('mousedown', e => {
  isDragging = true;
  const rect = modal.getBoundingClientRect();
  dragOffset.x = e.clientX - rect.left;
  dragOffset.y = e.clientY - rect.top;
  document.body.style.userSelect = 'none';
});

// Dragging
window.addEventListener('mousemove', e => {
  if (!isDragging) return;
  modal.style.left = `${e.clientX - dragOffset.x}px`;
  modal.style.top  = `${e.clientY - dragOffset.y}px`;
});

// Drag end
window.addEventListener('mouseup', () => {
  isDragging = false;
  document.body.style.userSelect = '';
});

// Helper to extract ID
function parseYouTubeId(url) {
  const match = url.match(/(?:v=|\.be\/)([\w-]{11})/);
  return match ? match[1] : null;
}
