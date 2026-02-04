const path = require("path");
const { DefinePlugin, optimize } = require("webpack");
require("dotenv").config();

module.exports = (env, argv) => {
  const isProduction = argv.mode === "production";
  const backendHost = process.env.CANVA_BACKEND_HOST || "";

  if (!backendHost) {
    console.warn("WARNING: CANVA_BACKEND_HOST is not set. Set it before running webpack.");
  } else if (backendHost.includes("localhost") && isProduction) {
    console.error("ERROR: CANVA_BACKEND_HOST must not be localhost for production builds.");
  }

  const config = {
    mode: isProduction ? "production" : "development",
    entry: {
      app: path.resolve(__dirname, "src", "index.tsx"),
    },
    target: "web",
    resolve: {
      extensions: [".tsx", ".ts", ".js", ".css"],
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: {
            loader: "ts-loader",
            options: { transpileOnly: true },
          },
        },
        // CSS from node_modules (e.g. @canva/app-ui-kit)
        {
          test: /\.css$/,
          include: /node_modules/,
          use: ["style-loader", "css-loader"],
        },
      ],
    },
    output: {
      filename: "[name].js",
      path: path.resolve(__dirname, "dist"),
      clean: true,
    },
    // Single-file output is required by Canva — suppress the size warning
    performance: { hints: false },

    plugins: [
      new DefinePlugin({
        BACKEND_HOST: JSON.stringify(backendHost),
      }),
      // Canva Developer Portal requires exactly one JS file
      new optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
    ],
  };

  if (!isProduction) {
    config.devtool = "source-map";
    config.devServer = {
      port: 8080,
      host: "localhost",
      historyApiFallback: {
        rewrites: [{ from: /^\/$/, to: "/app.js" }],
      },
    };
  }

  return config;
};
