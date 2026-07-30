const axios = require("axios");

module.exports = {
  config: {
    name: "music",
    aliases: ["song", "sing"],
    version: "1.0",
    author: "JayBohol",
    description: { en: "Search a song and play a preview clip in chat (iTunes)" },
    usage: "/music <song name>"
  },

  /**
   * Runs the /music command. Searches iTunes for the given query and
   * returns the top match's preview clip + artwork.
   * @param {string} query - the text after "/music "
   * @returns {Promise<{ title: string, artist: string, previewUrl: string, artwork: string|null }>}
   */
  run: async function (query) {
    if (!query || !query.trim()) {
      throw new Error("Please provide a song name. Example: /music umaasa");
    }

    const response = await axios.get("https://itunes.apple.com/search", {
      params: {
        term: query,
        media: "music",
        entity: "song",
        limit: 1
      },
      timeout: 15000
    });

    const results = response.data && response.data.results;

    if (!results || results.length === 0) {
      throw new Error(`No songs found for "${query}".`);
    }

    const song = results[0];

    if (!song.previewUrl) {
      throw new Error("Found the song, but no preview clip is available for it.");
    }

    const artwork = song.artworkUrl100
      ? song.artworkUrl100.replace("100x100bb", "600x600bb")
      : null;

    return {
      title: song.trackName || query,
      artist: song.artistName || "",
      previewUrl: song.previewUrl,
      artwork
    };
  }
};
