const DEFAULT_LEVELS = ['exhigh', 'standard'];

function firstPlayableUrl(body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  return data.find((item) => item?.url && item?.code === 200) || null;
}

function unplayableBody(id, sourceBody = {}) {
  const sourceData = Array.isArray(sourceBody?.data) ? sourceBody.data[0] : null;
  return {
    code: 200,
    data: [{
      ...(sourceData || {}),
      id: String(id),
      url: null,
      code: sourceData?.code || 404,
    }],
  };
}

export async function resolveSongUrl({
  id,
  cookie = '',
  api,
  levels = DEFAULT_LEVELS,
}) {
  let lastBody = null;
  for (const level of levels) {
    const response = await api.song_url_v1({
      id,
      level,
      ...(cookie ? { cookie } : {}),
    });
    lastBody = response.body;
    if (firstPlayableUrl(lastBody)) {
      return lastBody;
    }
  }

  const legacyResponse = await api.song_url({
    id,
    br: 320000,
    ...(cookie ? { cookie } : {}),
  });
  lastBody = legacyResponse.body;
  if (firstPlayableUrl(lastBody)) {
    return lastBody;
  }

  return unplayableBody(id, lastBody);
}
