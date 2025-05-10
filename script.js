// script.js
let chart;
let youtubePlayer;

// Preloaded demo event data
const demoEventData = [
  { time: 5, event: "start" },
  { time: 10, event: "goal" },
  { time: 20, event: "foul" },
  { time: 30, event: "goal" },
  { time: 45, event: "halftime" },
  { time: 60, event: "goal" },
  { time: 75, event: "substitution" },
  { time: 90, event: "end" }
];

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

document.getElementById('loadButton').addEventListener('click', () => {
  const url = document.getElementById('youtubeUrl').value;
  loadYouTubeVideo(url);

  const enrichedData = demoEventData.map((e, i) => ({
    ...e,
    score: i // example: increase score with each event
  }));
  loadChart(enrichedData);
});

document.getElementById('playButton').addEventListener('click', playFromStart);

document.addEventListener('DOMContentLoaded', () => {
  setupYouTubeAPI();

  // Load chart immediately with demo data
  const enrichedData = demoEventData.map((e, i) => ({
    ...e,
    score: i // example scoring
  }));
  loadChart(enrichedData);
});
