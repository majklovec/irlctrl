/**
 * Fetches the current viewer count for a Twitch channel.
 * @param {string} channelLogin - The channel's login name (e.g., "shroud").
 * @returns {Promise<number|null>} Viewer count, or null if offline.
 */
async function getTwitchViewerCount(channelLogin) {
    const url = "https://gql.twitch.tv/gql";
    const clientId = "kimne78kx3ncx6brgo4mv6wki5h1ko";

    const query = `
    query GetViewerCount($login: String!) {
      user(login: $login) {
        stream {
          viewersCount
        }
      }
    }
  `;

    const body = {
        query,
        variables: { login: channelLogin },
    };

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Client-ID": clientId,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`Twitch GQL request failed: ${response.status}`);
    }

    const json = await response.json();

    // If the channel is offline, `stream` is null.
    const stream = json.data?.user?.stream;
    return stream ? stream.viewersCount : null;
}

// Example usage:
getTwitchViewerCount("agraelus").then((count) => {
    if (count !== null) {
        console.log(`Current viewers: ${count}`);
    } else {
        console.log("Channel is offline.");
    }
});
