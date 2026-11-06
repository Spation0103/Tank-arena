export const ROOM_CONFIGS = [
  {
    id: "ALPHA-07",
    name: "Sector 07",
    maxPlayers: 12,
    arena: {
      width: 960,
      height: 600,
      obstacles: [
        { x: 170, y: 140, radius: 27, vx: -16, vy: 11 },
        { x: 390, y: 430, radius: 37, vx: 12, vy: -9 },
        { x: 690, y: 180, radius: 31, vx: -8, vy: 15 },
        { x: 820, y: 440, radius: 23, vx: 18, vy: 12 },
        { x: 530, y: 100, radius: 20, vx: 0, vy: 0 },
      ],
      pickup: { x: 480, y: 450 },
    },
  },
  {
    id: "BRAVO-12",
    name: "Dust Field",
    maxPlayers: 12,
    arena: {
      width: 960,
      height: 600,
      obstacles: [
        { x: 230, y: 300, radius: 42, vx: -10, vy: 6 },
        { x: 470, y: 155, radius: 25, vx: 14, vy: 12 },
        { x: 720, y: 335, radius: 35, vx: -8, vy: -14 },
        { x: 510, y: 500, radius: 22, vx: 6, vy: -12 },
      ],
      pickup: { x: 480, y: 300 },
    },
  },
];
