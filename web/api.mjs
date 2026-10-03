/** Same-origin HTTP client; only the server's public error envelope is exposed. */
export function createApi(baseUrl = '') {
  const base = baseUrl.replace(/\/$/u, '');
  const id = value => encodeURIComponent(value);
  async function request(path, { method = 'GET', json, blob, output = 'json', signal } = {}) {
    let response;
    try {
      response = await fetch(base + path, { method, headers: json === undefined && blob === undefined ? {} :
        { 'Content-Type': blob ? blob.type : 'application/json' },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }), ...(blob === undefined ? {} : { body: blob }), ...(signal === undefined ? {} : { signal }) });
    } catch { throw { code: 'NETWORK_ERROR', message: '无法连接本地服务，请检查服务是否仍在运行', status: 0 }; }
    if (!response.ok) {
      let error;
      try { error = (await response.json()).error; } catch { /* Keep non-JSON failures public and bounded. */ }
      throw { code: error?.code || 'HTTP_ERROR', message: error?.message || '请求失败，请重试', status: response.status,
        ...(error?.fields === undefined ? {} : { fields: error.fields }) };
    }
    if (output === 'blob') return response.blob();
    try { return await response.json(); } catch { throw { code: 'RESPONSE_INVALID', message: '本地服务返回的数据无法读取', status: response.status }; }
  }
  const resume = value => `/api/resumes/${id(value)}`;
  return {
    environment: () => request('/api/environment'),
    async list() { return (await request('/api/resumes')).resumes; },
    create: payload => request('/api/resumes', { method: 'POST', json: payload }),
    read: value => request(resume(value)),
    save: (value, payload) => request(resume(value), { method: 'PUT', json: payload }),
    copy: (value, payload) => request(`${resume(value)}/copy`, { method: 'POST', json: payload }),
    uploadAsset: (value, file) => request(`${resume(value)}/assets`, { method: 'POST', blob: file }),
    backup: value => request(`${resume(value)}/backup`, { output: 'blob' }),
    importBackup: file => request('/api/backups/import', { method: 'POST', blob: file.slice(0, file.size, 'application/json') }),
    submitBuild: (value, payload) => request(`${resume(value)}/builds`, { method: 'POST', json: payload }),
    readBuild: (value, { signal } = {}) => request(`/api/builds/${id(value)}`, { signal }),
  };
}
