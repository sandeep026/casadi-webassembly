// Legendre-Gauss-Lobatto pseudospectral optimal-control example.
// The initial guess for U uses scalar DM values because the browser SWIG
// binding does not convert spread JavaScript numbers to DM automatically.

function legendreAll(N, x) {
  const length = x.length;
  let P0 = new Array(length).fill(1);
  let P1 = x.slice();
  let dP0 = new Array(length).fill(0);
  let dP1 = new Array(length).fill(1);
  let d2P0 = new Array(length).fill(0);
  let d2P1 = new Array(length).fill(0);
  if (N === 0) return [P0, dP0, d2P0];
  if (N === 1) return [P1, dP1, d2P1];

  for (let k = 1; k < N; k++) {
    const P2 = new Array(length);
    const dP2 = new Array(length);
    const d2P2 = new Array(length);
    for (let i = 0; i < length; i++) {
      P2[i] = ((2 * k + 1) * x[i] * P1[i] - k * P0[i]) / (k + 1);
      dP2[i] = ((2 * k + 1) * (P1[i] + x[i] * dP1[i]) - k * dP0[i]) / (k + 1);
      d2P2[i] = ((2 * k + 1) * (2 * dP1[i] + x[i] * d2P1[i]) - k * d2P0[i]) / (k + 1);
    }
    P0 = P1; P1 = P2; dP0 = dP1; dP1 = dP2; d2P0 = d2P1; d2P1 = d2P2;
  }
  return [P1, dP1, d2P1];
}

function lglNodes(N) {
  if (N < 1) throw new Error("Degree N must be at least 1.");
  const nodes = Array.from({ length: N + 1 }, (_, k) => -Math.cos((Math.PI * k) / N));
  nodes[0] = -1; nodes[N] = 1;
  if (N > 1) {
    const interior = nodes.slice(1, N);
    for (let iteration = 0; iteration < 100; iteration++) {
      const [, dP, d2P] = legendreAll(N, interior);
      let largestStep = 0;
      for (let i = 0; i < interior.length; i++) {
        const step = dP[i] / d2P[i];
        interior[i] -= step;
        largestStep = Math.max(largestStep, Math.abs(step));
      }
      if (largestStep < 1e-15) break;
    }
    interior.forEach((value, index) => { nodes[index + 1] = value; });
  }
  for (let i = 0; i <= N; i++) nodes[i] = 0.5 * (nodes[i] - nodes[N - i]);
  return nodes;
}

function lglWeights(N) {
  const nodes = lglNodes(N);
  const [PN] = legendreAll(N, nodes);
  return PN.map((value, index) => {
    const weight = 2 / (N * (N + 1) * value * value);
    return 0.5 * (weight + 2 / (N * (N + 1) * PN[N - index] * PN[N - index]));
  });
}

function lglDiffMatrix(N) {
  const nodes = lglNodes(N);
  const [PN] = legendreAll(N, nodes);
  const matrix = Array.from({ length: N + 1 }, () => new Array(N + 1).fill(0));
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      if (i !== j) matrix[i][j] = (PN[i] / PN[j]) / (nodes[i] - nodes[j]);
    }
    matrix[i][i] = -matrix[i].reduce((sum, value) => sum + value, 0);
  }
  return matrix;
}

async function example(M, log) {
  const N = 25;
  const t0 = 0;
  const tf = 2;
  const nx = 2;
  const nu = 1;
  const opti = new M.Opti();
  const X = opti.variable(nx, N + 1);
  const U = opti.variable(nu, N + 1);
  const Xc = M.horzsplit(X);
  const Uc = M.horzsplit(U);
  const tau = lglNodes(N);
  const weights = lglWeights(N);
  const D = lglDiffMatrix(N);
  const columns = D.map((row) => M.vertcat(...row.map((value) => M.DM(value))));
  const differentiation = M.MX(M.horzcat(...columns));
  const initialState = M.vertcat(0, 1);
  const dynamics = M.horzcat(...Xc.map((state, index) => {
    const [, speed] = M.vertsplit(state);
    return M.vertcat(M.power(speed, 3), Uc[index]);
  }));

  opti.subject_to(M.eq(M.minus(M.mtimes(X, differentiation), M.times((tf - t0) / 2, dynamics)), 0));
  opti.subject_to(M.eq(Xc[0], initialState));
  const [finalPosition, finalSpeed] = M.vertsplit(Xc[N]);
  const mayer = M.plus(M.times(4, finalPosition), finalSpeed);
  const runningCost = weights.reduce((sum, weight, index) => M.plus(sum, M.times(weight, M.times(4, M.power(Uc[index], 2)))), M.MX(0));
  opti.minimize(M.plus(mayer, M.times((tf - t0) / 2, runningCost)));

  const initialColumns = Array.from({ length: N + 1 }, (_, index) => M.DM([index / N, index / N]));
  opti.set_initial(X, M.horzcat(...initialColumns));
  opti.set_initial(U, M.horzcat(...new Array(N + 1).fill(1).map((value) => M.DM(value))));
  opti.solver("ipopt");
  const solution = opti.solve();
  const XValue = solution.value(X);
  const UValue = solution.value(U);
  const [x1, x2] = M.vertsplit(XValue);
  const times = tau.map((node) => ((tf - t0) / 2) * node + 0.5 * (tf + t0));

  log("-----");
  log("LGL Pseudospectral OCP solved successfully");
  log("ts = " + times.map((value) => value.toFixed(4)).join(" "));
  log("x1 = " + x1.nonzeros().map((value) => value.toFixed(4)).join(" "));
  log("x2 = " + x2.nonzeros().map((value) => value.toFixed(4)).join(" "));
  log("u = " + UValue.nonzeros().map((value) => value.toFixed(4)).join(" "));
}
