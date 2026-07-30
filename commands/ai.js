const axios = require("axios");

module.exports = {
  config: {
    name: "ai",
    aliases: [],
    version: "1.0",
    author: "JayBohol",
    description: { en: "Ask the AI assistant a question in chat" },
    usage: "/ai <your question>"
  },

  /**
   * Runs the /ai command.
   * @param {string} prompt - the text after "/ai "
   * @returns {Promise<string>} the AI's reply (already trimmed to a safe length)
   */
  run: async function (prompt) {
    if (!prompt || !prompt.trim()) {
      throw new Error("Please ask a question. Example: /ai who is David?");
    }

    const response = await axios.get("https://selovapi.onrender.com/api/jay", {
      params: {
        prompt: prompt,
        uid: "8" // can be made dynamic per-user later
      },
      timeout: 15000
    });

    let aiReply = "Sorry, I couldn't understand that.";

    if (response.data) {
      if (response.data.response) {
        aiReply = response.data.response;
      } else if (response.data.answer) {
        aiReply = response.data.answer;
      } else if (response.data.message) {
        aiReply = response.data.message;
      } else if (response.data.result) {
        aiReply = response.data.result;
      } else if (typeof response.data === "string") {
        aiReply = response.data;
      } else {
        aiReply = JSON.stringify(response.data);
      }
    }

    return aiReply.substring(0, 2000);
  }
};
