"use client";

import React from 'react';
import { Copy, Check, Eye, EyeOff } from 'lucide-react';

interface InputFieldProps {
  label: string;
  value: string;
  onChange: (val: string) => void;
  placeholder: string;
  icon: React.ElementType;
  type?: string;
  showToggle?: boolean;
  toggleState: boolean;
  onToggle?: () => void;
  onCopy: () => void;
  isCopied: boolean;
}

const InputField = ({
  label,
  value,
  onChange,
  placeholder,
  icon: Icon,
  type = 'text',
  showToggle = false,
  toggleState,
  onToggle,
  onCopy,
  isCopied,
}: InputFieldProps) => {
  const inputType = showToggle ? (toggleState ? 'text' : 'password') : type;
  
  return (
    <div>
      <label className="block text-sm font-medium text-slate-600 mb-1">{label}</label>
      <div className="relative">
        <Icon className="absolute left-2.5 top-2.5 text-slate-400 w-4 h-4 pointer-events-none" />
        <input
          type={inputType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full pl-9 pr-20 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all"
        />
        <div className="absolute right-1.5 top-1.5 flex gap-0.5">
          {showToggle && onToggle && (
            <button
              type="button"
              onClick={onToggle}
              className="p-1.5 text-slate-400 hover:text-slate-600 rounded transition-colors"
            >
              {toggleState ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          )}
          <button
            type="button"
            onClick={onCopy}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded transition-colors"
          >
            {isCopied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
};

export default InputField;