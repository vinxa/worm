// script.js
let chart;
let youtubePlayer;

async function fetchDemoData() {
  const response = await fetch('data/sample-game.json');
  const data = await response.json();
  return data.map((e, i) => ({
    ...e,
    score: i // example scoring
  }));
}

function loadYouTubeVideo(url) {
  const videoId = url.split('v=')[1]?.split('&')[0];
  if (!videoId) return;
  const embedUrl = `https://www.youtube.com/embed/${videoId}?enablejsapi=1`;
  const iframe = document.getElementById('youtubePlayer');
  iframe.src = embedUrl;
}

function loadChart(data) {
  const times = data.map(e => e.time);
  const values = data.map(e => e.score);

  chart = Highcharts.chart('scoreChart', {
    title: { text: 'Score Over Time' },
    xAxis: { title: { text: 'Time (s)' }, categories: times },
    yAxis: { title: { text: 'Score' } },
    series: [{
      name: 'Score',
      data: values
    }],
    plotOptions: {
      series: {
        cursor: 'pointer',
        point: {
          events: {
            click: function () {
              seekYouTubeTo(data[this.index].time);
            }
          }
        }
      }
    }
  });
}

function seekYouTubeTo(seconds) {
  youtubePlayer?.contentWindow.postMessage(JSON.stringify({
    event: 'command',
    func: 'seekTo',
    args: [seconds, true]
  }), '*');
}

function setupYouTubeAPI() {
  window.onYouTubeIframeAPIReady = () => {
    youtubePlayer = document.getElementById('youtubePlayer');
  };
}

function playFromStart() {
  seekYouTubeTo(0);
  youtubePlayer?.contentWindow.postMessage(JSON.stringify({
    event: 'command',
    func: 'playVideo'
  }), '*');
}

document.getElementById('loadButton').addEventListener('click', async () => {
  const url = document.getElementById('youtubeUrl').value;
  loadYouTubeVideo(url);

  const data = await fetchDemoData();
  loadChart(data);
});

document.getElementById('playButton').addEventListener('click', playFromStart);

document.addEventListener('DOMContentLoaded', async () => {
  setupYouTubeAPI();

  // Preload default YouTube video
  const defaultVideoUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  document.getElementById('youtubeUrl').value = defaultVideoUrl;
  loadYouTubeVideo(defaultVideoUrl);

  const data = await fetchDemoData();
  loadChart(data);
});
