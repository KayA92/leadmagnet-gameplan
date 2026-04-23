export interface Speaker {
  name: string;
  job_title: string;
  company: string;
  profile_url: string;
}

export interface Session {
  session_id: string;
  title: string;
  day: string;
  date: string;
  theatre: string;
  start_time: string;
  end_time: string;
  categories: string;
  canonical_categories: string[];
  description: string;
  speakers: Speaker[];
  session_url: string;
  stage1_score?: number;
}

export interface Exhibitor {
  company_name: string;
  stand_number: string;
  show_category: string;
  normalised_products: string[];
  products_target: string[];
  company_description: string;
  website: string;
  is_host?: boolean;
  stage1_score?: number;
}

export interface UserProfile {
  attend_mode: string;
  problem: string;
  categories: string[];
  time_window: string;
  role: string;
  first_name: string;
}

export interface RankedSession {
  session_id: string;
  rank: number;
  reason: string;
}

export interface RankedBooth {
  company_name: string;
  stand_number: string;
  rank: number;
  reason: string;
}

export interface MatchResponse {
  sessions: RankedSession[];
  booths: RankedBooth[];
  themes: string[];
}

export interface MatchRequest {
  user_profile: UserProfile;
  sessions: Session[];
  exhibitors: Exhibitor[];
}
