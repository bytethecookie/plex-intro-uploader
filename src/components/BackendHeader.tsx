"use client";

import { Server } from 'lucide-react';

const BackendHeader = () => (
  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
    <div className="flex items-start gap-3">
      <Server className="text-blue-500 mt-0.5" />
      <div>
        <h3 className="font-semibold text-blue-700">Backend Status: Active</h3>
        <p className="text-sm text-blue-600 mt-1">
          The backend is configured to run on <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs">http://localhost:8000</code>. Ensure the Python app is running to enable full functionality.
        </p>
      </div>
    </div>
  </div>
);

export default BackendHeader;