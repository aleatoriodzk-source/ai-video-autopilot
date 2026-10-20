export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      activity_logs: {
        Row: {
          created_at: string
          data: Json | null
          id: string
          job_id: string | null
          level: string
          message: string
          production_id: string | null
          step: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          data?: Json | null
          id?: string
          job_id?: string | null
          level?: string
          message: string
          production_id?: string | null
          step?: string | null
          user_id?: string
        }
        Update: {
          created_at?: string
          data?: Json | null
          id?: string
          job_id?: string | null
          level?: string
          message?: string
          production_id?: string | null
          step?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "activity_logs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_logs_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
        ]
      }
      agents: {
        Row: {
          created_at: string
          id: string
          info: Json | null
          last_seen_at: string | null
          name: string
          revoked: boolean
          token_hash: string
          token_prefix: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          info?: Json | null
          last_seen_at?: string | null
          name: string
          revoked?: boolean
          token_hash: string
          token_prefix: string
          user_id?: string
        }
        Update: {
          created_at?: string
          id?: string
          info?: Json | null
          last_seen_at?: string | null
          name?: string
          revoked?: boolean
          token_hash?: string
          token_prefix?: string
          user_id?: string
        }
        Relationships: []
      }
      analyses: {
        Row: {
          created_at: string
          error: string | null
          id: string
          kind: string
          reference_id: string | null
          report: Json | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          error?: string | null
          id?: string
          kind: string
          reference_id?: string | null
          report?: Json | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          error?: string | null
          id?: string
          kind?: string
          reference_id?: string | null
          report?: Json | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "analyses_reference_id_fkey"
            columns: ["reference_id"]
            isOneToOne: false
            referencedRelation: "reference_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      assets: {
        Row: {
          attribution: string | null
          created_at: string
          description: string | null
          id: string
          kind: string
          license: string | null
          local_path: string | null
          meta: Json
          production_id: string | null
          source: string
          source_url: string | null
          storage_path: string | null
          user_id: string
        }
        Insert: {
          attribution?: string | null
          created_at?: string
          description?: string | null
          id?: string
          kind: string
          license?: string | null
          local_path?: string | null
          meta?: Json
          production_id?: string | null
          source: string
          source_url?: string | null
          storage_path?: string | null
          user_id?: string
        }
        Update: {
          attribution?: string | null
          created_at?: string
          description?: string | null
          id?: string
          kind?: string
          license?: string | null
          local_path?: string | null
          meta?: Json
          production_id?: string | null
          source?: string
          source_url?: string | null
          storage_path?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "assets_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          analysis_id: string | null
          attempts: number
          completed_steps: string[]
          created_at: string
          error: string | null
          id: string
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          payload: Json
          production_id: string | null
          progress: number
          reference_id: string | null
          status: string
          step: string | null
          type: string
          updated_at: string
          user_id: string
          wait_reason: string | null
        }
        Insert: {
          analysis_id?: string | null
          attempts?: number
          completed_steps?: string[]
          created_at?: string
          error?: string | null
          id?: string
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          production_id?: string | null
          progress?: number
          reference_id?: string | null
          status?: string
          step?: string | null
          type: string
          updated_at?: string
          user_id?: string
          wait_reason?: string | null
        }
        Update: {
          analysis_id?: string | null
          attempts?: number
          completed_steps?: string[]
          created_at?: string
          error?: string | null
          id?: string
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          payload?: Json
          production_id?: string | null
          progress?: number
          reference_id?: string | null
          status?: string
          step?: string | null
          type?: string
          updated_at?: string
          user_id?: string
          wait_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "jobs_analysis_id_fkey"
            columns: ["analysis_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_reference_id_fkey"
            columns: ["reference_id"]
            isOneToOne: false
            referencedRelation: "reference_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      productions: {
        Row: {
          aspect: string
          created_at: string
          current_step: string | null
          id: string
          ideas: Json | null
          mode: string
          output_path: string | null
          preview_path: string | null
          reference_id: string | null
          report: Json | null
          script: Json | null
          settings: Json
          status: string
          style_id: string | null
          title: string
          topic: string | null
          updated_at: string
          user_id: string
          validation: Json | null
          versions: Json
        }
        Insert: {
          aspect?: string
          created_at?: string
          current_step?: string | null
          id?: string
          ideas?: Json | null
          mode?: string
          output_path?: string | null
          preview_path?: string | null
          reference_id?: string | null
          report?: Json | null
          script?: Json | null
          settings?: Json
          status?: string
          style_id?: string | null
          title?: string
          topic?: string | null
          updated_at?: string
          user_id?: string
          validation?: Json | null
          versions?: Json
        }
        Update: {
          aspect?: string
          created_at?: string
          current_step?: string | null
          id?: string
          ideas?: Json | null
          mode?: string
          output_path?: string | null
          preview_path?: string | null
          reference_id?: string | null
          report?: Json | null
          script?: Json | null
          settings?: Json
          status?: string
          style_id?: string | null
          title?: string
          topic?: string | null
          updated_at?: string
          user_id?: string
          validation?: Json | null
          versions?: Json
        }
        Relationships: [
          {
            foreignKeyName: "productions_reference_id_fkey"
            columns: ["reference_id"]
            isOneToOne: false
            referencedRelation: "reference_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "productions_style_id_fkey"
            columns: ["style_id"]
            isOneToOne: false
            referencedRelation: "style_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      reference_sources: {
        Row: {
          collected: Json | null
          created_at: string
          id: string
          kind: string
          notes: string | null
          platform: string
          status: string
          title: string | null
          updated_at: string
          urls: string[]
          user_id: string
        }
        Insert: {
          collected?: Json | null
          created_at?: string
          id?: string
          kind: string
          notes?: string | null
          platform: string
          status?: string
          title?: string | null
          updated_at?: string
          urls: string[]
          user_id?: string
        }
        Update: {
          collected?: Json | null
          created_at?: string
          id?: string
          kind?: string
          notes?: string | null
          platform?: string
          status?: string
          title?: string | null
          updated_at?: string
          urls?: string[]
          user_id?: string
        }
        Relationships: []
      }
      scenes: {
        Row: {
          asset_id: string | null
          audio_duration_s: number | null
          audio_path: string | null
          caption: string | null
          created_at: string
          duration_s: number | null
          id: string
          idx: number
          motion: string | null
          narration: string
          pacing: string | null
          pause_after_ms: number
          production_id: string
          sfx: string | null
          status: string
          transition: string | null
          updated_at: string
          user_id: string
          visual_description: string | null
          visual_query: string | null
          word_timings: Json | null
        }
        Insert: {
          asset_id?: string | null
          audio_duration_s?: number | null
          audio_path?: string | null
          caption?: string | null
          created_at?: string
          duration_s?: number | null
          id?: string
          idx: number
          motion?: string | null
          narration?: string
          pacing?: string | null
          pause_after_ms?: number
          production_id: string
          sfx?: string | null
          status?: string
          transition?: string | null
          updated_at?: string
          user_id?: string
          visual_description?: string | null
          visual_query?: string | null
          word_timings?: Json | null
        }
        Update: {
          asset_id?: string | null
          audio_duration_s?: number | null
          audio_path?: string | null
          caption?: string | null
          created_at?: string
          duration_s?: number | null
          id?: string
          idx?: number
          motion?: string | null
          narration?: string
          pacing?: string | null
          pause_after_ms?: number
          production_id?: string
          sfx?: string | null
          status?: string
          transition?: string | null
          updated_at?: string
          user_id?: string
          visual_description?: string | null
          visual_query?: string | null
          word_timings?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "scenes_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
        ]
      }
      style_profiles: {
        Row: {
          analysis_id: string | null
          created_at: string
          edit_template: Json
          id: string
          name: string
          profile: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          analysis_id?: string | null
          created_at?: string
          edit_template?: Json
          id?: string
          name: string
          profile?: Json
          updated_at?: string
          user_id?: string
        }
        Update: {
          analysis_id?: string | null
          created_at?: string
          edit_template?: Json
          id?: string
          name?: string
          profile?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "style_profiles_analysis_id_fkey"
            columns: ["analysis_id"]
            isOneToOne: false
            referencedRelation: "analyses"
            referencedColumns: ["id"]
          },
        ]
      }
      usage_records: {
        Row: {
          cost_usd: number | null
          created_at: string
          id: string
          job_id: string | null
          operation: string
          production_id: string | null
          provider: string
          unit_name: string
          units: number
          user_id: string
        }
        Insert: {
          cost_usd?: number | null
          created_at?: string
          id?: string
          job_id?: string | null
          operation: string
          production_id?: string | null
          provider: string
          unit_name?: string
          units?: number
          user_id?: string
        }
        Update: {
          cost_usd?: number | null
          created_at?: string
          id?: string
          job_id?: string | null
          operation?: string
          production_id?: string | null
          provider?: string
          unit_name?: string
          units?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "usage_records_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "usage_records_production_id_fkey"
            columns: ["production_id"]
            isOneToOne: false
            referencedRelation: "productions"
            referencedColumns: ["id"]
          },
        ]
      }
      user_api_keys: {
        Row: {
          api_key: string
          provider: string
          updated_at: string
          user_id: string
        }
        Insert: {
          api_key: string
          provider: string
          updated_at?: string
          user_id: string
        }
        Update: {
          api_key?: string
          provider?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          data: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          data?: Json
          updated_at?: string
          user_id?: string
        }
        Update: {
          data?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
